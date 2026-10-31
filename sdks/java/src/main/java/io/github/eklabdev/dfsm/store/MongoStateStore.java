package io.github.eklabdev.dfsm.store;

import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.FindOneAndUpdateOptions;
import com.mongodb.client.model.Indexes;
import com.mongodb.client.model.ReturnDocument;
import com.mongodb.client.model.Sorts;
import com.mongodb.client.model.Updates;
import com.mongodb.client.result.DeleteResult;
import io.github.eklabdev.dfsm.DfsmModels.ActiveStepInfo;
import io.github.eklabdev.dfsm.DfsmModels.CompensationEntryRecord;
import io.github.eklabdev.dfsm.DfsmModels.InFlightFilter;
import io.github.eklabdev.dfsm.DfsmModels.TransactionRecord;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSnapshot;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSummary;
import io.github.eklabdev.dfsm.JsonCodec;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.error.StaleTransactionVersionException;
import org.bson.Document;
import org.bson.conversions.Bson;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Production MongoDB {@link StateStore} using atomic document optimistic concurrency ({@code version}),
 * embedded compensation stacks, and compound indexes.
 */
public final class MongoStateStore implements StateStore {
    private final String connectionUri;
    private final String databaseName;
    private final String collectionName;
    private MongoClient client;
    private MongoCollection<Document> collection;
    private volatile boolean initialized = false;

    public MongoStateStore(String connectionUri, String databaseName) {
        this(connectionUri, databaseName, "dfsm_java_transactions");
    }

    public MongoStateStore(String connectionUri, String databaseName, String collectionName) {
        this.connectionUri = connectionUri;
        this.databaseName = databaseName;
        this.collectionName = collectionName != null ? collectionName : "dfsm_java_transactions";
    }

    @Override
    public String kind() {
        return "mongodb";
    }

    @Override
    public synchronized void initialize() {
        if (initialized) {
            return;
        }
        this.client = MongoClients.create(connectionUri);
        MongoDatabase db = client.getDatabase(databaseName);
        this.collection = db.getCollection(collectionName);
        this.collection.createIndex(Indexes.ascending("machineId", "status", "updatedAt"));
        this.collection.createIndex(Indexes.ascending("actorId", "status", "leaseExpiresAt"));
        this.initialized = true;
    }

    @Override
    public <TContext> void createTransaction(TransactionRecord<TContext> r) {
        initialize();
        Document doc = new Document("_id", r.transactionId())
                .append("machineId", r.machineId())
                .append("machineVersion", r.machineVersion())
                .append("actorId", r.actorId())
                .append("stateJson", JsonCodec.toJson(r.stateValue()))
                .append("contextJson", JsonCodec.toJson(r.context()))
                .append("status", r.status().name())
                .append("activeStepJson", r.activeStep() != null ? JsonCodec.toJson(r.activeStep()) : null)
                .append("lastError", r.lastError())
                .append("version", r.version())
                .append("leaseOwner", r.leaseOwner())
                .append("leaseExpiresAt", r.leaseExpiresAt())
                .append("createdAt", r.createdAt())
                .append("updatedAt", r.updatedAt())
                .append("compensationStack", List.of());

        collection.insertOne(doc);
    }

    @Override
    public <TContext> TransactionSnapshot<TContext> getTransaction(String transactionId, Class<TContext> contextClass) {
        initialize();
        Document doc = collection.find(Filters.eq("_id", transactionId)).first();
        if (doc == null) {
            return null;
        }
        List<CompensationEntryRecord> stack = parseCompStack(doc, transactionId);
        String activeStepJson = doc.getString("activeStepJson");
        return new TransactionSnapshot<>(
                transactionId,
                doc.getString("machineId"),
                doc.getString("machineVersion"),
                doc.getString("actorId"),
                JsonCodec.fromJson(doc.getString("stateJson"), StateValue.class),
                JsonCodec.fromJson(doc.getString("contextJson"), contextClass),
                TransactionStatus.valueOf(doc.getString("status")),
                activeStepJson != null ? JsonCodec.fromJson(activeStepJson, ActiveStepInfo.class) : null,
                doc.getString("lastError"),
                doc.getLong("version"),
                doc.getString("leaseOwner"),
                doc.get("leaseExpiresAt", Long.class),
                doc.getLong("createdAt"),
                doc.getLong("updatedAt"),
                stack
        );
    }

    private List<CompensationEntryRecord> parseCompStack(Document doc, String txId) {
        List<Document> rawStack = doc.getList("compensationStack", Document.class, List.of());
        List<CompensationEntryRecord> out = new ArrayList<>();
        for (Document c : rawStack) {
            out.add(new CompensationEntryRecord(
                    c.getInteger("stepSeq"),
                    txId,
                    c.getString("transitionKey"),
                    c.getString("compensateKey"),
                    JsonCodec.fromJson(c.getString("fromStateJson"), StateValue.class),
                    JsonCodec.fromJson(c.getString("inputJson"), Object.class),
                    JsonCodec.fromJson(c.getString("contextBeforeJson"), Object.class),
                    c.getLong("createdAt"),
                    c.get("compensatedAt", Long.class)
            ));
        }
        return List.copyOf(out);
    }

    @Override
    public <TContext> long updateTransaction(
            String transactionId,
            long expectedVersion,
            TransactionPatch<TContext> patch,
            List<NewCompensationEntry> appendCompensations
    ) {
        initialize();
        long nextVersion = expectedVersion + 1;
        List<Bson> updates = new ArrayList<>();

        if (patch.stateValue() != null) {
            updates.add(Updates.set("stateJson", JsonCodec.toJson(patch.stateValue())));
        }
        if (patch.updateContext()) {
            updates.add(Updates.set("contextJson", JsonCodec.toJson(patch.context())));
        }
        if (patch.status() != null) {
            updates.add(Updates.set("status", patch.status().name()));
        }
        if (patch.updateActiveStep()) {
            updates.add(Updates.set("activeStepJson",
                    patch.activeStep() != null ? JsonCodec.toJson(patch.activeStep()) : null));
        }
        if (patch.updateLastError()) {
            updates.add(Updates.set("lastError", patch.lastError()));
        }
        if (patch.updateLease()) {
            updates.add(Updates.set("leaseOwner", patch.leaseOwner()));
            updates.add(Updates.set("leaseExpiresAt", patch.leaseExpiresAt()));
        }
        updates.add(Updates.set("version", nextVersion));
        updates.add(Updates.set("updatedAt", patch.updatedAt()));

        if (appendCompensations != null && !appendCompensations.isEmpty()) {
            Document existing = collection.find(Filters.eq("_id", transactionId)).first();
            if (existing == null) {
                throw new StaleTransactionVersionException(transactionId, expectedVersion);
            }
            List<Document> stack = existing.getList("compensationStack", Document.class, List.of());
            int baseSeq = stack.stream().mapToInt(d -> d.getInteger("stepSeq", 0)).max().orElse(0);

            List<Document> toPush = new ArrayList<>();
            for (int i = 0; i < appendCompensations.size(); i++) {
                NewCompensationEntry c = appendCompensations.get(i);
                toPush.add(new Document("stepSeq", baseSeq + i + 1)
                        .append("transitionKey", c.transitionKey())
                        .append("compensateKey", c.compensateKey())
                        .append("fromStateJson", JsonCodec.toJson(c.fromState()))
                        .append("inputJson", JsonCodec.toJson(c.inputSnapshot()))
                        .append("contextBeforeJson", JsonCodec.toJson(c.contextBefore()))
                        .append("createdAt", c.createdAt())
                        .append("compensatedAt", null));
            }
            updates.add(Updates.pushEach("compensationStack", toPush));
        }

        Document updated = collection.findOneAndUpdate(
                Filters.and(Filters.eq("_id", transactionId), Filters.eq("version", expectedVersion)),
                Updates.combine(updates),
                new FindOneAndUpdateOptions().returnDocument(ReturnDocument.AFTER)
        );
        if (updated == null) {
            throw new StaleTransactionVersionException(transactionId, expectedVersion);
        }
        return nextVersion;
    }

    @Override
    public List<CompensationEntryRecord> getUncompensatedStack(String transactionId) {
        initialize();
        Document doc = collection.find(Filters.eq("_id", transactionId)).first();
        if (doc == null) {
            return List.of();
        }
        return parseCompStack(doc, transactionId).stream()
                .filter(c -> c.compensatedAt() == null)
                .sorted(Comparator.comparingInt(CompensationEntryRecord::stepSeq).reversed())
                .toList();
    }

    @Override
    public void markCompensationExecuted(String transactionId, int stepSeq, long compensatedAt) {
        initialize();
        collection.updateOne(
                Filters.and(
                        Filters.eq("_id", transactionId),
                        Filters.eq("compensationStack.stepSeq", stepSeq)
                ),
                Updates.set("compensationStack.$.compensatedAt", compensatedAt)
        );
    }

    @Override
    public boolean deleteTransaction(String transactionId, Long expectedVersion) {
        initialize();
        Bson filter = expectedVersion != null
                ? Filters.and(Filters.eq("_id", transactionId), Filters.eq("version", expectedVersion))
                : Filters.eq("_id", transactionId);
        DeleteResult res = collection.deleteOne(filter);
        if (res.getDeletedCount() == 0 && expectedVersion != null) {
            if (collection.find(Filters.eq("_id", transactionId)).first() != null) {
                throw new StaleTransactionVersionException(transactionId, expectedVersion);
            }
        }
        return res.getDeletedCount() > 0;
    }

    @Override
    public long countInFlight(InFlightFilter filter, long nowEpochMs, long stuckThresholdMs) {
        initialize();
        return collection.countDocuments(buildInFlightBson(filter, nowEpochMs, stuckThresholdMs));
    }

    @Override
    public <TContext> List<TransactionSummary<TContext>> listInFlight(
            InFlightFilter filter,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    ) {
        initialize();
        int limit = filter != null && filter.limit() > 0 ? filter.limit() : 200;
        int offset = filter != null && filter.offset() > 0 ? filter.offset() : 0;
        List<Document> docs = collection.find(buildInFlightBson(filter, nowEpochMs, stuckThresholdMs))
                .sort(Sorts.ascending("updatedAt"))
                .skip(offset)
                .limit(limit)
                .into(new ArrayList<>());
        return toSummaries(docs, nowEpochMs, stuckThresholdMs, contextClass);
    }

    @Override
    public long countByStatuses(StatusQueryFilter filter) {
        initialize();
        return collection.countDocuments(buildStatusBson(filter));
    }

    @Override
    public <TContext> List<TransactionSummary<TContext>> listByStatuses(
            StatusQueryFilter filter,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    ) {
        initialize();
        int limit = filter != null && filter.limit() > 0 ? filter.limit() : 200;
        int offset = filter != null && filter.offset() > 0 ? filter.offset() : 0;
        List<Document> docs = collection.find(buildStatusBson(filter))
                .sort(Sorts.ascending("updatedAt"))
                .skip(offset)
                .limit(limit)
                .into(new ArrayList<>());
        return toSummaries(docs, nowEpochMs, stuckThresholdMs, contextClass);
    }

    @Override
    public Map<TransactionStatus, Long> getStatusCounts(String machineId) {
        initialize();
        Map<TransactionStatus, Long> map = new EnumMap<>(TransactionStatus.class);
        for (TransactionStatus st : TransactionStatus.values()) {
            map.put(st, 0L);
        }
        for (TransactionStatus st : TransactionStatus.values()) {
            Bson f = machineId != null
                    ? Filters.and(Filters.eq("machineId", machineId), Filters.eq("status", st.name()))
                    : Filters.eq("status", st.name());
            map.put(st, collection.countDocuments(f));
        }
        return map;
    }

    private <TContext> List<TransactionSummary<TContext>> toSummaries(
            List<Document> docs,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    ) {
        List<TransactionSummary<TContext>> out = new ArrayList<>();
        for (Document doc : docs) {
            String txId = doc.getString("_id");
            TransactionStatus status = TransactionStatus.valueOf(doc.getString("status"));
            long updatedAt = doc.getLong("updatedAt");
            Long leaseExp = doc.get("leaseExpiresAt", Long.class);
            boolean isStuck = (status == TransactionStatus.IN_FLIGHT || status == TransactionStatus.COMPENSATING)
                    && ((nowEpochMs - updatedAt) > stuckThresholdMs || (leaseExp != null && leaseExp <= nowEpochMs));
            String activeStepJson = doc.getString("activeStepJson");
            int uncomp = (int) parseCompStack(doc, txId).stream()
                    .filter(c -> c.compensatedAt() == null)
                    .count();
            out.add(new TransactionSummary<>(
                    txId,
                    doc.getString("machineId"),
                    doc.getString("actorId"),
                    JsonCodec.fromJson(doc.getString("stateJson"), StateValue.class),
                    status,
                    JsonCodec.fromJson(doc.getString("contextJson"), contextClass),
                    isStuck,
                    activeStepJson != null ? JsonCodec.fromJson(activeStepJson, ActiveStepInfo.class) : null,
                    uncomp,
                    doc.getLong("version"),
                    doc.getLong("createdAt"),
                    updatedAt
            ));
        }
        return List.copyOf(out);
    }

    private static Bson buildInFlightBson(InFlightFilter f, long nowEpochMs, long stuckThresholdMs) {
        List<Bson> filters = new ArrayList<>();
        boolean includeComp = f == null || f.includeCompensating();
        filters.add(includeComp
                ? Filters.in("status", "IN_FLIGHT", "COMPENSATING")
                : Filters.eq("status", "IN_FLIGHT"));
        if (f != null) {
            if (f.machineId() != null) filters.add(Filters.eq("machineId", f.machineId()));
            if (f.actorId() != null) filters.add(Filters.eq("actorId", f.actorId()));
            if (f.stateEquals() != null) {
                filters.add(Filters.eq("stateJson", JsonCodec.toJson(StateValue.of(f.stateEquals()))));
            }
            if (f.stuckOnly()) {
                filters.add(Filters.or(
                        Filters.lt("updatedAt", nowEpochMs - stuckThresholdMs),
                        Filters.and(Filters.ne("leaseExpiresAt", null), Filters.lte("leaseExpiresAt", nowEpochMs))
                ));
            }
        }
        return Filters.and(filters);
    }

    private static Bson buildStatusBson(StatusQueryFilter f) {
        List<Bson> filters = new ArrayList<>();
        if (f != null) {
            if (f.machineId() != null) filters.add(Filters.eq("machineId", f.machineId()));
            if (f.actorId() != null) filters.add(Filters.eq("actorId", f.actorId()));
            if (f.statuses() != null && !f.statuses().isEmpty()) {
                filters.add(Filters.in("status", f.statuses().stream().map(Enum::name).toList()));
            }
            if (f.updatedBeforeEpochMs() != null) {
                filters.add(Filters.lte("updatedAt", f.updatedBeforeEpochMs()));
            }
        }
        return filters.isEmpty() ? new Document() : Filters.and(filters);
    }

    @Override
    public synchronized void close() {
        if (client != null) {
            client.close();
            client = null;
        }
        initialized = false;
    }
}

