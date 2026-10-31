package io.github.eklabdev.dfsm.store;

import io.github.eklabdev.dfsm.DfsmModels.ActiveStepInfo;
import io.github.eklabdev.dfsm.DfsmModels.CompensationEntryRecord;
import io.github.eklabdev.dfsm.DfsmModels.InFlightFilter;
import io.github.eklabdev.dfsm.DfsmModels.TransactionRecord;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSnapshot;
import io.github.eklabdev.dfsm.DfsmModels.TransactionSummary;
import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;

import java.util.List;
import java.util.Map;

/**
 * Pluggable durable storage SPI for DFSM transactions and LIFO Saga compensation stacks.
 * Implemented out of the box by {@link H2StateStore} (default in-memory DB),
 * {@link PostgresStateStore}, and {@link MongoStateStore}.
 */
public interface StateStore extends AutoCloseable {

    record NewCompensationEntry(
            String transactionId,
            String transitionKey,
            String compensateKey,
            StateValue fromState,
            Object inputSnapshot,
            Object contextBefore,
            long createdAt
    ) {}

    record TransactionPatch<TContext>(
            StateValue stateValue,
            boolean updateContext,
            TContext context,
            TransactionStatus status,
            boolean updateActiveStep,
            ActiveStepInfo activeStep,
            boolean updateLastError,
            String lastError,
            boolean updateLease,
            String leaseOwner,
            Long leaseExpiresAt,
            long updatedAt
    ) {
        public static <C> Builder<C> builder(long updatedAt) {
            return new Builder<>(updatedAt);
        }

        public static final class Builder<C> {
            private StateValue stateValue;
            private boolean updateContext;
            private C context;
            private TransactionStatus status;
            private boolean updateActiveStep;
            private ActiveStepInfo activeStep;
            private boolean updateLastError;
            private String lastError;
            private boolean updateLease;
            private String leaseOwner;
            private Long leaseExpiresAt;
            private final long updatedAt;

            private Builder(long updatedAt) {
                this.updatedAt = updatedAt;
            }

            public Builder<C> stateValue(StateValue sv) {
                this.stateValue = sv;
                return this;
            }

            public Builder<C> context(C ctx) {
                this.updateContext = true;
                this.context = ctx;
                return this;
            }

            public Builder<C> status(TransactionStatus st) {
                this.status = st;
                return this;
            }

            public Builder<C> activeStep(ActiveStepInfo step) {
                this.updateActiveStep = true;
                this.activeStep = step;
                return this;
            }

            public Builder<C> lastError(String err) {
                this.updateLastError = true;
                this.lastError = err;
                return this;
            }

            public Builder<C> lease(String owner, Long expiresAt) {
                this.updateLease = true;
                this.leaseOwner = owner;
                this.leaseExpiresAt = expiresAt;
                return this;
            }

            public TransactionPatch<C> build() {
                return new TransactionPatch<>(
                        stateValue, updateContext, context, status,
                        updateActiveStep, activeStep, updateLastError, lastError,
                        updateLease, leaseOwner, leaseExpiresAt, updatedAt
                );
            }
        }
    }

    record StatusQueryFilter(
            String machineId,
            String actorId,
            List<TransactionStatus> statuses,
            Long updatedBeforeEpochMs,
            int limit,
            int offset
    ) {}

    String kind();

    void initialize();

    <TContext> void createTransaction(TransactionRecord<TContext> record);

    <TContext> TransactionSnapshot<TContext> getTransaction(String transactionId, Class<TContext> contextClass);

    /**
     * Atomically updates a transaction using optimistic concurrency ({@code expectedVersion})
     * and optionally appends new {@link NewCompensationEntry} records to its Saga stack.
     *
     * @return the incremented version ({@code expectedVersion + 1})
     */
    <TContext> long updateTransaction(
            String transactionId,
            long expectedVersion,
            TransactionPatch<TContext> patch,
            List<NewCompensationEntry> appendCompensations
    );

    List<CompensationEntryRecord> getUncompensatedStack(String transactionId);

    void markCompensationExecuted(String transactionId, int stepSeq, long compensatedAt);

    boolean deleteTransaction(String transactionId, Long expectedVersion);

    long countInFlight(InFlightFilter filter, long nowEpochMs, long stuckThresholdMs);

    <TContext> List<TransactionSummary<TContext>> listInFlight(
            InFlightFilter filter,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    );

    long countByStatuses(StatusQueryFilter filter);

    <TContext> List<TransactionSummary<TContext>> listByStatuses(
            StatusQueryFilter filter,
            long nowEpochMs,
            long stuckThresholdMs,
            Class<TContext> contextClass
    );

    Map<TransactionStatus, Long> getStatusCounts(String machineId);

    @Override
    void close();
}

