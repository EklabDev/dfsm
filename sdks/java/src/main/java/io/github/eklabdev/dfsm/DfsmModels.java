package io.github.eklabdev.dfsm;

import io.github.eklabdev.dfsm.policy.CircuitStatus;
import io.github.eklabdev.dfsm.policy.NormalizedTransitionPolicy;
import io.github.eklabdev.dfsm.policy.PartialTransitionPolicy;

import java.util.List;
import java.util.Map;

/**
 * Operational, persistence, scheduler, cleanup, and introspection models for {@code FSMRegistry} and {@code DfsmActor}.
 */
public final class DfsmModels {
    private DfsmModels() {}

    public record ActiveStepInfo(
            String event,
            Object input,
            long startedAt
    ) {}

    public record CompensationEntryRecord(
            int stepSeq,
            String transactionId,
            String transitionKey,
            String compensateKey,
            StateValue fromState,
            Object inputSnapshot,
            Object contextBefore,
            long createdAt,
            Long compensatedAt
    ) {}

    public record TransactionRecord<TContext>(
            String transactionId,
            String machineId,
            String machineVersion,
            String actorId,
            StateValue stateValue,
            TContext context,
            TransactionStatus status,
            ActiveStepInfo activeStep,
            String lastError,
            long version,
            String leaseOwner,
            Long leaseExpiresAt,
            long createdAt,
            long updatedAt
    ) {}

    public record TransactionSnapshot<TContext>(
            String transactionId,
            String machineId,
            String machineVersion,
            String actorId,
            StateValue stateValue,
            TContext context,
            TransactionStatus status,
            ActiveStepInfo activeStep,
            String lastError,
            long version,
            String leaseOwner,
            Long leaseExpiresAt,
            long createdAt,
            long updatedAt,
            List<CompensationEntryRecord> compensationStack
    ) {}

    public record TransactionSummary<TContext>(
            String transactionId,
            String machineId,
            String actorId,
            StateValue stateValue,
            TransactionStatus status,
            TContext context,
            boolean isStuck,
            ActiveStepInfo activeStep,
            int compensationDepth,
            long version,
            long createdAt,
            long updatedAt
    ) {}

    public enum OnRestartMode {
        STOP,
        MARK_FAIL,
        DELETE,
        COMPENSATE,
        CONTINUE
    }

    public record RecoveryConfig(
            boolean enabled,
            long stuckThresholdMs,
            OnRestartMode defaultAction,
            Map<String, OnRestartMode> perStateActions
    ) {
        public static RecoveryConfig defaults() {
            return new RecoveryConfig(false, 30_000L, OnRestartMode.STOP, Map.of());
        }
    }

    public record SchedulerConfig(
            boolean enabled,
            long sweepIntervalMs,
            long stuckThresholdMs,
            Long retentionMs,
            int batchSize
    ) {
        public static SchedulerConfig defaults() {
            return new SchedulerConfig(false, 15_000L, 30_000L, null, 100);
        }
    }

    public record SweepReport(
            long sweptAt,
            int stuckRecoveredCount,
            int expiredPurgedCount,
            Map<String, String> actionsByTxId
    ) {}

    public record SchedulerStatus(
            boolean enabled,
            boolean isRunning,
            long sweepIntervalMs,
            long stuckThresholdMs,
            Long retentionMs,
            Long lastRunAt,
            Long nextRunAt,
            SweepReport lastSweepReport
    ) {}

    public enum ForceCleanUpAction {
        DELETE,
        MARK_FAIL,
        COMPENSATE,
        FORCE_UNLOCK
    }

    public record ForceCleanUpOptions(
            ForceCleanUpAction action,
            List<TransactionStatus> statuses,
            boolean includeInFlight,
            boolean stuckOnly,
            Long olderThanMs,
            boolean dryRun,
            int limit
    ) {
        public static ForceCleanUpOptions defaults() {
            return new ForceCleanUpOptions(
                    ForceCleanUpAction.DELETE,
                    List.of(TransactionStatus.COMPLETED, TransactionStatus.FAILED, TransactionStatus.COMPENSATED),
                    false,
                    false,
                    null,
                    false,
                    500
            );
        }
    }

    public record ForceCleanUpReport(
            boolean dryRun,
            ForceCleanUpAction action,
            int matchedCount,
            int affectedCount,
            List<String> transactionIds
    ) {}

    public record InFlightFilter(
            String machineId,
            String actorId,
            boolean stuckOnly,
            boolean includeCompensating,
            String stateEquals,
            int limit,
            int offset
    ) {
        public static InFlightFilter all() {
            return new InFlightFilter(null, null, false, true, null, 200, 0);
        }

        public static InFlightFilter onlyStuck() {
            return new InFlightFilter(null, null, true, true, null, 200, 0);
        }
    }

    public record StatusBreakdown(
            long nonTerminalCount,
            long terminalCount,
            Map<TransactionStatus, Long> byStatus
    ) {}

    public record TerminalStateDescriptor(
            String path,
            String kind,
            boolean isTopLevel,
            boolean hasOutgoingRecoveryTransitions,
            List<String> outgoingEvents
    ) {}

    public record TerminalStatesInfo(
            String machineId,
            List<String> topLevelTerminalStates,
            List<String> allFinalStatePaths,
            String errorStateMode,
            boolean errorStateIsFinal,
            List<TerminalStateDescriptor> states,
            List<TransactionStatus> terminalStatuses,
            List<TransactionStatus> nonTerminalStatuses
    ) {}

    public record MachineSummary(
            String id,
            String version,
            String source,
            String namespace,
            int stateCount,
            boolean hasCustomErrorState,
            int boundActorCount
    ) {}

    public enum HandlerKind {
        TRANSITION,
        COMPENSATE,
        EFFECT,
        HOOK
    }

    public record HandlerDescriptor(
            String name,
            HandlerKind kind,
            PartialTransitionPolicy policy
    ) {}

    public record EffectiveTransitionConfig(
            String statePath,
            String event,
            String target,
            String resolvedTransitionHandler,
            String resolvedCompensateHandler,
            NormalizedTransitionPolicy policy,
            CircuitStatus circuitBreakerState
    ) {}

    public record EffectiveMachineConfig(
            String machineId,
            String version,
            String source,
            boolean hasCustomErrorState,
            int maxEffectChainDepth,
            Map<LifecycleHookName, List<String>> resolvedHooks,
            List<String> registeredEffects,
            List<EffectiveTransitionConfig> transitions
    ) {}

    public record ActorSummary(
            String actorId,
            String machineId,
            boolean schedulerEnabled,
            OnRestartMode defaultRecoveryAction
    ) {}

    public record InFlightSummary(
            long totalInFlight,
            long totalCompensating,
            long totalStuck,
            Map<String, Long> byMachine
    ) {}
}
