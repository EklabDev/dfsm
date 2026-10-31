package io.github.eklabdev.dfsm.store;

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

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Default embedded in-memory SQL {@link StateStore} backed by H2 ({@code com.h2database:h2}).
 * Also supports file-backed H2 JDBC URLs for single-node persistent durability.
 */
public class H2StateStore implements StateStore {
    private final String jdbcUrl;
    private final String username;
    private final String password;
    private final String tablePrefix;
    private Connection keepAliveConn;
    private volatile boolean initialized = false;

    public H2StateStore() {
        this("jdbc:h2:mem:dfsm_" + UUID.randomUUID().toString().replace("-", "") + ";DB_CLOSE_DELAY=-1",
                "sa", "", "dfsm_");
    }

    public H2StateStore(String jdbcUrl) {
        this(jdbcUrl, "sa", "", "dfsm_");
    }

    public H2StateStore(String jdbcUrl, String username, String password, String tablePrefix) {
        this.jdbcUrl = jdbcUrl;
        this.username = username != null ? username : "sa";
        this.password = password != null ? password : "";
        this.tablePrefix = tablePrefix != null ? tablePrefix : "dfsm_";
    }

    protected String txTable() {
        return tablePrefix + "transactions";
    }

    protected String compTable() {
        return tablePrefix + "compensations";
    }

    protected Connection openConnection() throws SQLException {
        return DriverManager.getConnection(jdbcUrl, username, password);
    }

    @Override
    public String kind() {
        return "h2";
    }

    @Override
    public synchronized void initialize() {
        if (initialized) {
            return;
        }
        try {
            // Keep one anchor connection open so H2 mem DB stays alive until close()
            this.keepAliveConn = openConnection();
            try (Statement st = keepAliveConn.createStatement()) {
                st.execute("""
                        CREATE TABLE IF NOT EXISTS %s (
                            transaction_id VARCHAR(255) PRIMARY KEY,
                            machine_id VARCHAR(255) NOT NULL,
                            machine_version VARCHAR(64) NOT NULL,
                            actor_id VARCHAR(255) NOT NULL,
                            state_json CLOB NOT NULL,
                            context_json CLOB NOT NULL,
                            status VARCHAR(32) NOT NULL,
                            active_step_json CLOB,
                            last_error CLOB,
                            version BIGINT NOT NULL,
                            lease_owner VARCHAR(255),
                            lease_expires_at BIGINT,
                            created_at BIGINT NOT NULL,
                            updated_at BIGINT NOT NULL
                        )
                        """.formatted(txTable()));

                st.execute("""
                        CREATE INDEX IF NOT EXISTS idx_%s_machine_status_updated
                        ON %s (machine_id, status, updated_at)
                        """.formatted(tablePrefix, txTable()));

                st.execute("""
                        CREATE INDEX IF NOT EXISTS idx_%s_actor_status_lease
                        ON %s (actor_id, status, lease_expires_at)
                        """.formatted(tablePrefix, txTable()));

                st.execute("""
                        CREATE TABLE IF NOT EXISTS %s (
                            transaction_id VARCHAR(255) NOT NULL,
                            step_seq INT NOT NULL,
                            transition_key VARCHAR(255) NOT NULL,
                            compensate_key VARCHAR(255) NOT NULL,
                            from_state_json CLOB NOT NULL,
                            input_json CLOB,
                            context_before_json CLOB,
                            created_at BIGINT NOT NULL,
                            compensated_at BIGINT,
                            PRIMARY KEY (transaction_id, step_seq),
                            FOREIGN KEY (transaction_id) REFERENCES %s(transaction_id) ON DELETE CASCADE
                        )
                        """.formatted(compTable(), txTable()));
            }
            this.initialized = true;
        } catch (SQLException e) {
            throw new RuntimeException("Failed to initialize H2StateStore", e);
        }
    }

    @Override
    public <TContext> void createTransaction(TransactionRecord<TContext> r) {
        initialize();
        String sql = """
                INSERT INTO %s (
                    transaction_id, machine_id, machine_version, actor_id,
                    state_json, context_json, status, active_step_json, last_error,
                    version, lease_owner, lease_expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.formatted(txTable());

        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, r.transactionId());
            ps.setString(2, r.machineId());
            ps.setString(3, r.machineVersion());
            ps.setString(4, r.actorId());
            ps.setString(5, JsonCodec.toJson(r.stateValue()));
            ps.setString(6, JsonCodec.toJson(r.context()));
            ps.setString(7, r.status().name());
            ps.setString(8, r.activeStep() != null ? JsonCodec.toJson(r.activeStep()) : null);
            ps.setString(9, r.lastError());
            ps.setLong(10, r.version());
            ps.setString(11, r.leaseOwner());
            if (r.leaseExpiresAt() != null) {
                ps.setLong(12, r.leaseExpiresAt());
            } else {
                ps.setNull(12, Types.BIGINT);
            }
            ps.setLong(13, r.createdAt());
            ps.setLong(14, r.updatedAt());
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException("Failed to create transaction '" + r.transactionId() + "'", e);
        }
    }

    @Override
    public <TContext> TransactionSnapshot<TContext> getTransaction(String transactionId, Class<TContext> contextClass) {
        initialize();
        String sql = "SELECT * FROM " + txTable() + " WHERE transaction_id = ?";
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, transactionId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                StateValue stateValue = JsonCodec.fromJson(rs.getString("state_json"), StateValue.class);
                TContext context = JsonCodec.fromJson(rs.getString("context_json"), contextClass);
                TransactionStatus status = TransactionStatus.valueOf(rs.getString("status"));
                String activeStepStr = rs.getString("active_step_json");
                ActiveStepInfo activeStep = activeStepStr != null
                        ? JsonCodec.fromJson(activeStepStr, ActiveStepInfo.class)
                        : null;
                String lastError = rs.getString("last_error");
                long version = rs.getLong("version");
                String leaseOwner = rs.getString("lease_owner");
                long leaseExpRaw = rs.getLong("lease_expires_at");
                Long leaseExpiresAt = rs.wasNull() ? null : leaseExpRaw;
                long createdAt = rs.getLong("created_at");
                long updatedAt = rs.getLong("updated_at");
                String machineId = rs.getString("machine_id");
                String machineVersion = rs.getString("machine_version");
                String actorId = rs.getString("actor_id");

                List<CompensationEntryRecord> stack = loadFullCompensationStack(conn, transactionId);
                return new TransactionSnapshot<>(
                        transactionId, machineId, machineVersion, actorId,
                        stateValue, context, status, activeStep, lastError,
                        version, leaseOwner, leaseExpiresAt, createdAt, updatedAt, stack
                );
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to load transaction '" + transactionId + "'", e);
        }
    }

    private List<CompensationEntryRecord> loadFullCompensationStack(Connection conn, String txId) throws SQLException {
        String sql = "SELECT * FROM " + compTable() + " WHERE transaction_id = ? ORDER BY step_seq ASC";
        List<CompensationEntryRecord> list = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, txId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    list.add(readCompRow(rs));
                }
            }
        }
        return List.copyOf(list);
    }

    private CompensationEntryRecord readCompRow(ResultSet rs) throws SQLException {
        long compRaw = rs.getLong("compensated_at");
        Long compensatedAt = rs.wasNull() ? null : compRaw;
        return new CompensationEntryRecord(
                rs.getInt("step_seq"),
                rs.getString("transaction_id"),
                rs.getString("transition_key"),
                rs.getString("compensate_key"),
                JsonCodec.fromJson(rs.getString("from_state_json"), StateValue.class),
                JsonCodec.fromJson(rs.getString("input_json"), Object.class),
                JsonCodec.fromJson(rs.getString("context_before_json"), Object.class),
                rs.getLong("created_at"),
                compensatedAt
        );
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

        try (Connection conn = openConnection()) {
            conn.setAutoCommit(false);
            try {
                List<String> sets = new ArrayList<>();
                List<Object> params = new ArrayList<>();

                if (patch.stateValue() != null) {
                    sets.add("state_json = ?");
                    params.add(JsonCodec.toJson(patch.stateValue()));
                }
                if (patch.updateContext()) {
                    sets.add("context_json = ?");
                    params.add(JsonCodec.toJson(patch.context()));
                }
                if (patch.status() != null) {
                    sets.add("status = ?");
                    params.add(patch.status().name());
                }
                if (patch.updateActiveStep()) {
                    sets.add("active_step_json = ?");
                    params.add(patch.activeStep() != null ? JsonCodec.toJson(patch.activeStep()) : null);
                }
                if (patch.updateLastError()) {
                    sets.add("last_error = ?");
                    params.add(patch.lastError());
                }
                if (patch.updateLease()) {
                    sets.add("lease_owner = ?");
                    params.add(patch.leaseOwner());
                    sets.add("lease_expires_at = ?");
                    params.add(patch.leaseExpiresAt());
                }
                sets.add("version = ?");
                params.add(nextVersion);
                sets.add("updated_at = ?");
                params.add(patch.updatedAt());

                params.add(transactionId);
                params.add(expectedVersion);

                String sql = "UPDATE " + txTable() + " SET " + String.join(", ", sets)
                        + " WHERE transaction_id = ? AND version = ?";

                try (PreparedStatement ps = conn.prepareStatement(sql)) {
                    for (int i = 0; i < params.size(); i++) {
                        Object p = params.get(i);
                        if (p == null) {
                            ps.setNull(i + 1, Types.VARCHAR);
                        } else if (p instanceof Long l) {
                            ps.setLong(i + 1, l);
                        } else {
                            ps.setString(i + 1, p.toString());
                        }
                    }
                    int updated = ps.executeUpdate();
                    if (updated == 0) {
                        conn.rollback();
                        throw new StaleTransactionVersionException(transactionId, expectedVersion);
                    }
                }

                if (appendCompensations != null && !appendCompensations.isEmpty()) {
                    int baseSeq = queryMaxStepSeq(conn, transactionId);
                    String insSql = """
                            INSERT INTO %s (
                                transaction_id, step_seq, transition_key, compensate_key,
                                from_state_json, input_json, context_before_json, created_at, compensated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
                            """.formatted(compTable());
                    try (PreparedStatement ins = conn.prepareStatement(insSql)) {
                        for (int i = 0; i < appendCompensations.size(); i++) {
                            NewCompensationEntry c = appendCompensations.get(i);
                            ins.setString(1, transactionId);
                            ins.setInt(2, baseSeq + i + 1);
                            ins.setString(3, c.transitionKey());
                            ins.setString(4, c.compensateKey());
                            ins.setString(5, JsonCodec.toJson(c.fromState()));
                            ins.setString(6, JsonCodec.toJson(c.inputSnapshot()));
                            ins.setString(7, JsonCodec.toJson(c.contextBefore()));
                            ins.setLong(8, c.createdAt());
                            ins.addBatch();
                        }
                        ins.executeBatch();
                    }
                }

                conn.commit();
                return nextVersion;
            } catch (RuntimeException | SQLException ex) {
                conn.rollback();
                if (ex instanceof RuntimeException re) throw re;
                throw new RuntimeException(ex);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to update transaction '" + transactionId + "'", e);
        }
    }

    private int queryMaxStepSeq(Connection conn, String txId) throws SQLException {
        String sql = "SELECT COALESCE(MAX(step_seq), 0) FROM " + compTable() + " WHERE transaction_id = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, txId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : 0;
            }
        }
    }

    @Override
    public List<CompensationEntryRecord> getUncompensatedStack(String transactionId) {
        initialize();
        String sql = "SELECT * FROM " + compTable()
                + " WHERE transaction_id = ? AND compensated_at IS NULL ORDER BY step_seq DESC";
        List<CompensationEntryRecord> out = new ArrayList<>();
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, transactionId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(readCompRow(rs));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to read uncompensated stack for '" + transactionId + "'", e);
        }
        return List.copyOf(out);
    }

    @Override
    public void markCompensationExecuted(String transactionId, int stepSeq, long compensatedAt) {
        initialize();
        String sql = "UPDATE " + compTable()
                + " SET compensated_at = ? WHERE transaction_id = ? AND step_seq = ?";
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, compensatedAt);
            ps.setString(2, transactionId);
            ps.setInt(3, stepSeq);
            ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException("Failed to mark compensation executed", e);
        }
    }

    @Override
    public boolean deleteTransaction(String transactionId, Long expectedVersion) {
        initialize();
        String sql = expectedVersion != null
                ? "DELETE FROM " + txTable() + " WHERE transaction_id = ? AND version = ?"
                : "DELETE FROM " + txTable() + " WHERE transaction_id = ?";
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, transactionId);
            if (expectedVersion != null) {
                ps.setLong(2, expectedVersion);
            }
            int affected = ps.executeUpdate();
            if (affected == 0 && expectedVersion != null) {
                // Check if row still exists with different version
                try (PreparedStatement chk = conn.prepareStatement(
                        "SELECT version FROM " + txTable() + " WHERE transaction_id = ?")) {
                    chk.setString(1, transactionId);
                    try (ResultSet rs = chk.executeQuery()) {
                        if (rs.next()) {
                            throw new StaleTransactionVersionException(transactionId, expectedVersion);
                        }
                    }
                }
            }
            return affected > 0;
        } catch (SQLException e) {
            throw new RuntimeException("Failed to delete transaction '" + transactionId + "'", e);
        }
    }

    @Override
    public long countInFlight(InFlightFilter filter, long nowEpochMs, long stuckThresholdMs) {
        initialize();
        QueryParts qp = buildInFlightWhere(filter, nowEpochMs, stuckThresholdMs);
        String sql = "SELECT COUNT(*) FROM " + txTable() + qp.whereClause;
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            bindParams(ps, qp.params);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getLong(1) : 0L;
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to count in-flight transactions", e);
        }
    }

    @Override
    public <TContext> List<TransactionSummary<TContext>> listInFlight(
            InFlightFilter filter,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    ) {
        initialize();
        QueryParts qp = buildInFlightWhere(filter, nowEpochMs, stuckThresholdMs);
        int limit = filter != null && filter.limit() > 0 ? filter.limit() : 200;
        int offset = filter != null && filter.offset() > 0 ? filter.offset() : 0;
        String sql = "SELECT t.*, (SELECT COUNT(*) FROM " + compTable()
                + " c WHERE c.transaction_id = t.transaction_id AND c.compensated_at IS NULL) AS comp_depth "
                + "FROM " + txTable() + " t " + qp.whereClause
                + " ORDER BY t.updated_at ASC LIMIT " + limit + " OFFSET " + offset;

        return executeSummaryQuery(sql, qp.params, nowEpochMs, stuckThresholdMs, contextClass);
    }

    @Override
    public long countByStatuses(StatusQueryFilter filter) {
        initialize();
        QueryParts qp = buildStatusWhere(filter);
        String sql = "SELECT COUNT(*) FROM " + txTable() + qp.whereClause;
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            bindParams(ps, qp.params);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getLong(1) : 0L;
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to count transactions by statuses", e);
        }
    }

    @Override
    public <TContext> List<TransactionSummary<TContext>> listByStatuses(
            StatusQueryFilter filter,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    ) {
        initialize();
        QueryParts qp = buildStatusWhere(filter);
        int limit = filter != null && filter.limit() > 0 ? filter.limit() : 200;
        int offset = filter != null && filter.offset() > 0 ? filter.offset() : 0;
        String sql = "SELECT t.*, (SELECT COUNT(*) FROM " + compTable()
                + " c WHERE c.transaction_id = t.transaction_id AND c.compensated_at IS NULL) AS comp_depth "
                + "FROM " + txTable() + " t " + qp.whereClause
                + " ORDER BY t.updated_at ASC LIMIT " + limit + " OFFSET " + offset;

        return executeSummaryQuery(sql, qp.params, nowEpochMs, stuckThresholdMs, contextClass);
    }

    @Override
    public Map<TransactionStatus, Long> getStatusCounts(String machineId) {
        initialize();
        Map<TransactionStatus, Long> map = new EnumMap<>(TransactionStatus.class);
        for (TransactionStatus st : TransactionStatus.values()) {
            map.put(st, 0L);
        }
        String sql = machineId != null
                ? "SELECT status, COUNT(*) FROM " + txTable() + " WHERE machine_id = ? GROUP BY status"
                : "SELECT status, COUNT(*) FROM " + txTable() + " GROUP BY status";
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            if (machineId != null) {
                ps.setString(1, machineId);
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    TransactionStatus st = TransactionStatus.valueOf(rs.getString(1));
                    map.put(st, rs.getLong(2));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to get status counts", e);
        }
        return map;
    }

    private <TContext> List<TransactionSummary<TContext>> executeSummaryQuery(
            String sql,
            List<Object> params,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    ) {
        List<TransactionSummary<TContext>> out = new ArrayList<>();
        try (Connection conn = openConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            bindParams(ps, params);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    TransactionStatus status = TransactionStatus.valueOf(rs.getString("status"));
                    long updatedAt = rs.getLong("updated_at");
                    long leaseExpRaw = rs.getLong("lease_expires_at");
                    Long leaseExpiresAt = rs.wasNull() ? null : leaseExpRaw;
                    boolean isStuck = (status == TransactionStatus.IN_FLIGHT || status == TransactionStatus.COMPENSATING)
                            && ((nowEpochMs - updatedAt) > stuckThresholdMs
                                || (leaseExpiresAt != null && leaseExpiresAt <= nowEpochMs));
                    String activeStepStr = rs.getString("active_step_json");
                    ActiveStepInfo activeStep = activeStepStr != null
                            ? JsonCodec.fromJson(activeStepStr, ActiveStepInfo.class)
                            : null;
                    out.add(new TransactionSummary<>(
                            rs.getString("transaction_id"),
                            rs.getString("machine_id"),
                            rs.getString("actor_id"),
                            JsonCodec.fromJson(rs.getString("state_json"), StateValue.class),
                            status,
                            JsonCodec.fromJson(rs.getString("context_json"), contextClass),
                            isStuck,
                            activeStep,
                            rs.getInt("comp_depth"),
                            rs.getLong("version"),
                            rs.getLong("created_at"),
                            updatedAt
                    ));
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to list transactions", e);
        }
        return List.copyOf(out);
    }

    private record QueryParts(String whereClause, List<Object> params) {}

    private static QueryParts buildInFlightWhere(InFlightFilter f, long nowEpochMs, long stuckThresholdMs) {
        List<String> clauses = new ArrayList<>();
        List<Object> params = new ArrayList<>();

        boolean includeComp = f == null || f.includeCompensating();
        if (includeComp) {
            clauses.add("status IN ('IN_FLIGHT', 'COMPENSATING')");
        } else {
            clauses.add("status = 'IN_FLIGHT'");
        }

        if (f != null) {
            if (f.machineId() != null) {
                clauses.add("machine_id = ?");
                params.add(f.machineId());
            }
            if (f.actorId() != null) {
                clauses.add("actor_id = ?");
                params.add(f.actorId());
            }
            if (f.stateEquals() != null) {
                clauses.add("state_json = ?");
                params.add(JsonCodec.toJson(StateValue.of(f.stateEquals())));
            }
            if (f.stuckOnly()) {
                clauses.add("(updated_at < ? OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?))");
                params.add(nowEpochMs - stuckThresholdMs);
                params.add(nowEpochMs);
            }
        }

        return new QueryParts(" WHERE " + String.join(" AND ", clauses), params);
    }

    private static QueryParts buildStatusWhere(StatusQueryFilter f) {
        List<String> clauses = new ArrayList<>();
        List<Object> params = new ArrayList<>();

        if (f != null) {
            if (f.machineId() != null) {
                clauses.add("machine_id = ?");
                params.add(f.machineId());
            }
            if (f.actorId() != null) {
                clauses.add("actor_id = ?");
                params.add(f.actorId());
            }
            if (f.statuses() != null && !f.statuses().isEmpty()) {
                List<String> ph = f.statuses().stream().map(s -> "?").toList();
                clauses.add("status IN (" + String.join(", ", ph) + ")");
                f.statuses().forEach(s -> params.add(s.name()));
            }
            if (f.updatedBeforeEpochMs() != null) {
                clauses.add("updated_at <= ?");
                params.add(f.updatedBeforeEpochMs());
            }
        }

        String where = clauses.isEmpty() ? "" : " WHERE " + String.join(" AND ", clauses);
        return new QueryParts(where, params);
    }

    private static void bindParams(PreparedStatement ps, List<Object> params) throws SQLException {
        for (int i = 0; i < params.size(); i++) {
            Object p = params.get(i);
            if (p instanceof Long l) {
                ps.setLong(i + 1, l);
            } else if (p instanceof Integer in) {
                ps.setInt(i + 1, in);
            } else {
                ps.setString(i + 1, String.valueOf(p));
            }
        }
    }

    @Override
    public synchronized void close() {
        if (keepAliveConn != null) {
            try {
                keepAliveConn.close();
            } catch (SQLException ignored) {}
            keepAliveConn = null;
        }
        initialized = false;
    }
}

