from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import math
import random
from copy import deepcopy
from typing import Any, Callable, Dict, Generic, List, Optional, Tuple, Type, TypeVar

from pydantic import BaseModel

from dfsm.circuit_breaker import CircuitBreakerInstance
from dfsm.definition import MachineDefinition
from dfsm.errors import (
    DfsmError,
    ExecutionFailedError,
    InvalidTransitionError,
    MaxEffectChainDepthExceededError,
    TransactionNotFoundError,
    UnregisteredHandlerError,
)
from dfsm.policy import PolicyMerger, TransitionPolicy
from dfsm.registry import FSMRegistry, default_registry
from dfsm.state_value import StateValue
from dfsm.statechart import StatechartEngine
from dfsm.telemetry import BenchmarkEvent
from dfsm.types import (
    ActorStateRecord,
    AfterTransitionEvent,
    BeforeTransitionEvent,
    CompensationRequest,
    EffectRequest,
    ForceCleanUpAction,
    ForceCleanUpOptions,
    ForceCleanUpResult,
    HookType,
    InFlightSummary,
    OnCompensateEvent,
    OnCompleteEvent,
    OnStartEvent,
    OnTerminalEvent,
    SagaStepRecord,
    StatusBreakdown,
    TContext,
    TransactionRecord,
    TransactionStatus,
    TransitionExecutionResult,
    TransitionOutput,
    TransitionRequest,
)


class DfsmActor(Generic[TContext]):
    def __init__(
        self,
        machine: MachineDefinition,
        registry: Optional[FSMRegistry] = None,
        context_type: Optional[Type[TContext]] = None,
    ) -> None:
        self.machine = machine
        self.registry = registry or default_registry
        self.context_type = context_type
        self._circuit_breakers: Dict[str, CircuitBreakerInstance] = {}
        self._cb_lock = asyncio.Lock()

    @property
    def machine_id(self) -> str:
        return self.machine.id

    def get_terminal_states(self) -> List[str]:
        return StatechartEngine.get_terminal_states(self.machine)

    def get_available_events(self, state: StateValue) -> List[str]:
        return StatechartEngine.get_available_events(self.machine, state)

    async def get_state(self, tx_id: str) -> ActorStateRecord[TContext]:
        rec = await self.registry.store.get_transaction(tx_id)
        if not rec:
            raise TransactionNotFoundError(tx_id)

        ctx = self._deserialize_context(rec.context_json)
        return ActorStateRecord(
            transaction_id=rec.transaction_id,
            machine_id=rec.machine_id,
            current_state=rec.current_state,
            status=rec.status,
            version=rec.version,
            context=ctx,
            created_at=rec.created_at,
            updated_at=rec.updated_at,
        )

    async def start(
        self, tx_id: str, initial_context: Optional[TContext] = None
    ) -> ActorStateRecord[TContext]:
        if initial_context is not None and self.context_type is None:
            self.context_type = type(initial_context)

        existing = await self.registry.store.get_transaction(tx_id)
        if existing:
            return await self.get_state(tx_id)

        init_res = StatechartEngine.resolve_initial_state(self.machine)
        now = self.registry.clock.now_ms()
        ctx_json = self._serialize_context(initial_context)

        rec = TransactionRecord(
            transaction_id=tx_id,
            machine_id=self.machine.id,
            current_state=init_res.state_value,
            status=TransactionStatus.IDLE,
            context_json=ctx_json,
            version=1,
            created_at=now,
            updated_at=now,
        )
        await self.registry.store.create_transaction(rec)

        await self._fire_hook(
            HookType.ON_START,
            OnStartEvent(transaction_id=tx_id, initial_state=init_res.state_value),
        )

        return await self.get_state(tx_id)

    async def transition(
        self,
        tx_id: str,
        event: str,
        input_payload: Optional[Any] = None,
        depth: int = 0,
    ) -> TransitionExecutionResult:
        if depth >= self.machine.max_effect_chain_depth:
            raise MaxEffectChainDepthExceededError(tx_id, self.machine.max_effect_chain_depth)

        # 1. Load or initialize transaction
        rec = await self.registry.store.get_transaction(tx_id)
        if not rec:
            init_res = StatechartEngine.resolve_initial_state(self.machine)
            now = self.registry.clock.now_ms()
            rec = TransactionRecord(
                transaction_id=tx_id,
                machine_id=self.machine.id,
                current_state=init_res.state_value,
                status=TransactionStatus.IDLE,
                context_json="{}",
                version=1,
                created_at=now,
                updated_at=now,
            )
            await self.registry.store.create_transaction(rec)

        # 2. Terminal checks
        if rec.status in (
            TransactionStatus.COMPLETED,
            TransactionStatus.FAILED,
            TransactionStatus.COMPENSATED,
        ):
            # Check if event can recover (e.g. RESET_ORDER or RECOVER)
            matched_test = StatechartEngine.find_transitions(self.machine, rec.current_state, event)
            if not matched_test:
                raise InvalidTransitionError(
                    str(rec.current_state),
                    event,
                    f"Cannot process event '{event}' because transaction '{tx_id}' is in terminal status '{rec.status.value}' (state: {rec.current_state})",
                )

        # 3. Match transition
        matched_list = StatechartEngine.find_transitions(self.machine, rec.current_state, event)
        if not matched_list:
            raise InvalidTransitionError(
                str(rec.current_state),
                event,
                f"No transition configured for event '{event}' from state '{rec.current_state}'",
            )

        matched = matched_list[0]
        handler_name = matched.edge.transition or event

        # 4. Merge policies
        reg_tx = self.registry.find_transition(handler_name)
        code_pol = reg_tx.policy if reg_tx else None
        trans_pol = matched.policy
        def_pol = self.machine.defaults
        global_pol = self.registry.global_policy

        policy = PolicyMerger.merge([code_pol, trans_pol, def_pol, global_pol])

        # 5. Fire BeforeTransition hook
        await self._fire_hook(
            HookType.BEFORE_TRANSITION,
            BeforeTransitionEvent(
                transaction_id=tx_id,
                current_state=rec.current_state,
                event_name=event,
            ),
        )

        # 6. Mark IN_FLIGHT
        orig_version = rec.version
        rec.status = TransactionStatus.IN_FLIGHT
        rec.updated_at = self.registry.clock.now_ms()
        rec.version = orig_version + 1
        await self.registry.store.update_transaction(rec, orig_version)
        in_flight_version = rec.version

        # 7. Execute Handler with Retry & Circuit Breaker
        cb_instance: Optional[CircuitBreakerInstance] = None
        if policy.circuit_breaker and policy.circuit_breaker.enabled:
            cb_instance = await self._get_or_create_circuit_breaker(handler_name, policy.circuit_breaker)

        user_ctx = self._deserialize_context(rec.context_json)
        original_ctx_json = rec.context_json

        max_attempts = max(1, policy.retry.max_attempts)
        attempts = 0
        last_err: Optional[Exception] = None
        handler_output: Optional[Any] = None
        t0 = self.registry.clock.now_ms()

        while attempts < max_attempts:
            attempts += 1
            try:
                if cb_instance:
                    cb_instance.before_execution(handler_name)

                # Execute transition handler
                res_output = await self._invoke_transition(
                    handler_name, reg_tx, tx_id, user_ctx, input_payload, rec.current_state, event
                )

                if res_output.context is not None:
                    user_ctx = res_output.context
                    rec.context_json = self._serialize_context(user_ctx)
                handler_output = res_output.output

                if cb_instance:
                    cb_instance.on_success()

                last_err = None
                break
            except Exception as ex:
                last_err = ex
                if cb_instance:
                    cb_instance.on_failure()

                if attempts < max_attempts:
                    delay_ms = self._compute_backoff(policy, attempts)
                    await asyncio.sleep(delay_ms / 1000.0)

        duration_ms = self.registry.clock.now_ms() - t0

        # 8. Success branch
        if last_err is None:
            prev_state = rec.current_state
            target_name = matched.edge.target or (matched.source_path[-1] if matched.source_path else "")

            applied = StatechartEngine.apply_target_transition(
                self.machine, rec.current_state, matched.source_path, target_name
            )
            rec.current_state = applied.next_state_value

            self.registry.benchmark.record(
                BenchmarkEvent(
                    transaction_id=tx_id,
                    machine_id=self.machine.id,
                    event_name=event,
                    handler_name=handler_name,
                    attempts=attempts,
                    outcome="SUCCESS",
                    duration_ms=duration_ms,
                    previous_state=prev_state,
                    current_state=rec.current_state,
                )
            )

            # Push Saga step if compensation configured
            if matched.edge.compensate:
                snap_str = json.dumps(input_payload) if input_payload is not None else None
                step = SagaStepRecord(
                    step_id=f"{tx_id}-{self.registry.clock.now_ms()}",
                    step_name=handler_name,
                    compensate_handler=matched.edge.compensate,
                    from_state=prev_state,
                    target_state=rec.current_state,
                    input_snapshot_json=snap_str,
                    context_before_json=original_ctx_json,
                    timestamp=self.registry.clock.now_ms(),
                )
                await self.registry.store.push_saga_step(tx_id, step)

            # Cascade onDone transitions
            while True:
                on_done_tuple = StatechartEngine.compute_on_done(self.machine, rec.current_state)
                if not on_done_tuple:
                    break
                next_sv, on_done_edges = on_done_tuple
                rec.current_state = next_sv
                for edge in on_done_edges:
                    for eff in edge.effects:
                        await self.run_effect(tx_id, eff, user_ctx=user_ctx, state=rec.current_state, event=event)

            # Determine final status
            is_final = False
            if rec.current_state.is_leaf():
                c_node = self.machine.states.get(str(rec.current_state.value))
                if c_node and c_node.is_final():
                    is_final = True

            rec.status = TransactionStatus.COMPLETED if is_final else TransactionStatus.IDLE
            rec.updated_at = self.registry.clock.now_ms()
            rec.version = in_flight_version + 1
            await self.registry.store.update_transaction(rec, in_flight_version)

            await self._fire_hook(
                HookType.AFTER_TRANSITION,
                AfterTransitionEvent(
                    transaction_id=tx_id,
                    event_name=event,
                    previous_state=prev_state,
                    current_state=rec.current_state,
                    status=rec.status,
                    compensated_steps=0,
                ),
            )

            if rec.status == TransactionStatus.COMPLETED:
                await self._fire_hook(
                    HookType.ON_COMPLETE,
                    OnCompleteEvent(
                        transaction_id=tx_id,
                        final_state=rec.current_state,
                        version=rec.version,
                    ),
                )
                await self._fire_hook(
                    HookType.ON_TERMINAL,
                    OnTerminalEvent(
                        transaction_id=tx_id,
                        final_state=rec.current_state,
                        status=rec.status,
                    ),
                )

            # Execute edge effects
            for eff in matched.edge.effects:
                await self.run_effect(tx_id, eff, user_ctx=user_ctx, state=rec.current_state, event=event)

            return TransitionExecutionResult(
                transaction_id=tx_id,
                event_name=event,
                previous_state=prev_state,
                current_state=rec.current_state,
                status=rec.status,
                version=rec.version,
                output_value=handler_output,
                compensated_steps=0,
                rollback_occurred=False,
            )

        # 9. Handle Failure & Saga Compensation Rollback
        err_msg = str(last_err)
        self.registry.benchmark.record(
            BenchmarkEvent(
                transaction_id=tx_id,
                machine_id=self.machine.id,
                event_name=event,
                handler_name=handler_name,
                attempts=attempts,
                outcome="FAILED",
                duration_ms=duration_ms,
                previous_state=rec.current_state,
                current_state=rec.current_state,
                error_message=err_msg,
            )
        )

        compensated_steps = 0
        rollback_triggered = bool(policy.on_fail and policy.on_fail.compensate)

        if rollback_triggered:
            rec.status = TransactionStatus.COMPENSATING
            stack = await self.registry.store.get_saga_stack(tx_id)
            remaining = len(stack)

            while remaining > 0:
                step = await self.registry.store.pop_saga_step(tx_id)
                if not step:
                    break

                comp_fn = self.registry.find_compensate(step.compensate_handler)
                if comp_fn:
                    in_snap = json.loads(step.input_snapshot_json) if step.input_snapshot_json else None
                    comp_req = CompensationRequest(
                        transaction_id=tx_id,
                        context=user_ctx,
                        step_name=step.step_name,
                        input_snapshot=in_snap,
                        from_state=step.from_state,
                        target_state=step.target_state,
                    )
                    await self._invoke_compensate(comp_fn, comp_req)

                    if step.context_before_json:
                        user_ctx = self._deserialize_context(step.context_before_json)
                        rec.context_json = step.context_before_json

                compensated_steps += 1
                remaining -= 1

                await self._fire_hook(
                    HookType.ON_COMPENSATE,
                    OnCompensateEvent(
                        transaction_id=tx_id,
                        step_name=step.step_name,
                        from_state=step.from_state,
                        target_state=step.target_state,
                        steps_remaining=remaining,
                    ),
                )

        fail_target = (policy.on_fail.target if policy.on_fail and policy.on_fail.target else None) or "error"
        fail_applied = StatechartEngine.apply_target_transition(
            self.machine, rec.current_state, matched.source_path, fail_target
        )
        rec.current_state = fail_applied.next_state_value

        rec.status = TransactionStatus.COMPENSATED if rollback_triggered else TransactionStatus.FAILED
        rec.updated_at = self.registry.clock.now_ms()
        rec.version = in_flight_version + 1
        await self.registry.store.update_transaction(rec, in_flight_version)

        await self._fire_hook(
            HookType.ON_TERMINAL,
            OnTerminalEvent(
                transaction_id=tx_id,
                final_state=rec.current_state,
                status=rec.status,
            ),
        )

        return TransitionExecutionResult(
            transaction_id=tx_id,
            event_name=event,
            previous_state=rec.current_state,
            current_state=rec.current_state,
            status=rec.status,
            version=rec.version,
            output_value=None,
            compensated_steps=compensated_steps,
            rollback_occurred=rollback_triggered,
        )

    async def run_effect(
        self,
        tx_id: str,
        effect_name: str,
        user_ctx: Optional[TContext] = None,
        state: Optional[StateValue] = None,
        event: Optional[str] = None,
    ) -> None:
        fn = self.registry.find_effect(effect_name)
        if not fn:
            if self.machine.registry and self.machine.registry.strict:
                raise UnregisteredHandlerError("effect", effect_name)
            return

        ctx = user_ctx
        if ctx is None:
            rec = await self.registry.store.get_transaction(tx_id)
            if rec:
                ctx = self._deserialize_context(rec.context_json)

        eff_req = EffectRequest(
            transaction_id=tx_id,
            context=ctx,
            event_name=event or "",
            state=state or StateValue.leaf(""),
            actor=self,
        )

        if inspect.iscoroutinefunction(fn):
            await fn(eff_req)
        else:
            fn(eff_req)

    async def get_status_breakdown(self) -> StatusBreakdown:
        all_txs = await self.registry.store.list_all_transactions(self.machine.id, 5000)
        b = StatusBreakdown()
        for r in all_txs:
            if r.status == TransactionStatus.IDLE:
                b.idle += 1
            elif r.status == TransactionStatus.IN_FLIGHT:
                b.in_flight += 1
            elif r.status == TransactionStatus.COMPENSATING:
                b.compensating += 1
            elif r.status == TransactionStatus.COMPENSATED:
                b.compensated += 1
            elif r.status == TransactionStatus.COMPLETED:
                b.completed += 1
            elif r.status == TransactionStatus.FAILED:
                b.failed += 1
        return b

    async def get_in_flight_summary(self) -> InFlightSummary:
        b = await self.get_status_breakdown()
        non_terminal = b.idle + b.in_flight + b.compensating
        terminals = self.get_terminal_states()
        return InFlightSummary(
            total_in_flight=b.in_flight,
            non_terminal_count=non_terminal,
            terminal_states=terminals,
            breakdown=b,
        )

    async def force_cleanup(self, opts: ForceCleanUpOptions) -> ForceCleanUpResult:
        if opts.transaction_ids:
            candidates: List[TransactionRecord] = []
            for tid in opts.transaction_ids:
                rec = await self.registry.store.get_transaction(tid)
                if rec:
                    candidates.append(rec)
        else:
            candidates = await self.registry.store.list_active_transactions(
                self.machine.id, opts.limit or 500
            )

        now = self.registry.clock.now_ms()
        filtered: List[TransactionRecord] = []
        for r in candidates:
            if opts.stuck_only and r.status != TransactionStatus.IN_FLIGHT:
                continue
            if opts.older_than_ms is not None:
                if (now - r.updated_at) < opts.older_than_ms:
                    continue
            filtered.append(r)

        matched_count = len(filtered)
        if opts.dry_run:
            return ForceCleanUpResult(
                matched_count=matched_count,
                processed_count=0,
                dry_run=True,
                action=opts.action,
                affected_transaction_ids=[r.transaction_id for r in filtered],
            )

        processed = 0
        action = opts.action or ForceCleanUpAction.MARK_FAIL
        for rec in filtered:
            if action == ForceCleanUpAction.MARK_FAIL:
                old_ver = rec.version
                rec.status = TransactionStatus.FAILED
                rec.current_state = StateValue.leaf("error")
                rec.updated_at = now
                rec.version = old_ver + 1
                await self.registry.store.update_transaction(rec, old_ver)
                processed += 1
            elif action == ForceCleanUpAction.COMPENSATE:
                while True:
                    step = await self.registry.store.pop_saga_step(rec.transaction_id)
                    if not step:
                        break
                    comp_fn = self.registry.find_compensate(step.compensate_handler)
                    if comp_fn:
                        in_snap = json.loads(step.input_snapshot_json) if step.input_snapshot_json else None
                        ctx = self._deserialize_context(rec.context_json)
                        comp_req = CompensationRequest(
                            transaction_id=rec.transaction_id,
                            context=ctx,
                            step_name=step.step_name,
                            input_snapshot=in_snap,
                            from_state=step.from_state,
                            target_state=step.target_state,
                        )
                        await self._invoke_compensate(comp_fn, comp_req)
                old_ver = rec.version
                rec.status = TransactionStatus.COMPENSATED
                rec.current_state = StateValue.leaf("error")
                rec.updated_at = now
                rec.version = old_ver + 1
                await self.registry.store.update_transaction(rec, old_ver)
                processed += 1
            elif action in (ForceCleanUpAction.STOP, ForceCleanUpAction.CONTINUE):
                old_ver = rec.version
                rec.status = TransactionStatus.IDLE
                rec.updated_at = now
                rec.version = old_ver + 1
                await self.registry.store.update_transaction(rec, old_ver)
                processed += 1

        return ForceCleanUpResult(
            matched_count=matched_count,
            processed_count=processed,
            dry_run=False,
            action=action,
            affected_transaction_ids=[r.transaction_id for r in filtered],
        )

    async def _invoke_transition(
        self,
        handler_name: str,
        reg_tx: Any,
        tx_id: str,
        ctx: Any,
        input_payload: Any,
        state: StateValue,
        event: str,
    ) -> TransitionOutput:
        if not reg_tx:
            # Fallback identity handler
            return TransitionOutput(context=ctx, output=None)

        fn = reg_tx.handler
        req = TransitionRequest(
            transaction_id=tx_id,
            context=ctx,
            input=input_payload,
            current_state=state,
            event_name=event,
        )

        sig = inspect.signature(fn)
        num_params = len(sig.parameters)

        if inspect.iscoroutinefunction(fn):
            raw = await fn(req) if num_params <= 1 else await fn(tx_id, ctx, input_payload, state, event)
        else:
            raw = fn(req) if num_params <= 1 else fn(tx_id, ctx, input_payload, state, event)

        if isinstance(raw, TransitionOutput):
            return raw
        if isinstance(raw, tuple):
            if len(raw) == 2:
                return TransitionOutput(context=raw[0], output=raw[1])
            if len(raw) == 1:
                return TransitionOutput(context=raw[0], output=None)
        if raw is not None:
            return TransitionOutput(context=raw, output=None)
        return TransitionOutput(context=ctx, output=None)

    async def _invoke_compensate(self, fn: Callable[..., Any], req: CompensationRequest) -> None:
        sig = inspect.signature(fn)
        if inspect.iscoroutinefunction(fn):
            await fn(req) if len(sig.parameters) <= 1 else await fn(req.transaction_id, req.context)
        else:
            fn(req) if len(sig.parameters) <= 1 else fn(req.transaction_id, req.context)

    async def _fire_hook(self, hook_type: HookType, payload: Any) -> None:
        hooks = self.registry.find_hooks(hook_type)
        for h in hooks:
            try:
                if inspect.iscoroutinefunction(h):
                    await h(payload)
                else:
                    h(payload)
            except Exception as e:
                print(f"[DFSM-HOOK-ERROR] Hook {hook_type} failed: {e}")

    async def _get_or_create_circuit_breaker(
        self, handler_name: str, policy: Any
    ) -> CircuitBreakerInstance:
        async with self._cb_lock:
            if handler_name not in self._circuit_breakers:
                self._circuit_breakers[handler_name] = CircuitBreakerInstance(
                    policy, self.registry.clock
                )
            return self._circuit_breakers[handler_name]

    def _compute_backoff(self, policy: TransitionPolicy, attempt: int) -> int:
        bm = policy.retry.backoff_ms
        strategy = (policy.retry.backoff or "EXPONENTIAL").upper()
        if strategy == "FIXED":
            delay = bm
        elif strategy == "LINEAR":
            delay = bm * attempt
        else:  # EXPONENTIAL
            factor = policy.retry.backoff_factor if policy.retry.backoff_factor > 0 else 2.0
            delay = int(bm * math.pow(factor, attempt - 1))

        if policy.retry.max_backoff_ms > 0:
            delay = min(delay, policy.retry.max_backoff_ms)

        if policy.retry.jitter:
            delay = int(random.uniform(0.5, 1.5) * delay)

        return max(1, delay)

    def _serialize_context(self, ctx: Any) -> str:
        if ctx is None:
            return "{}"
        if isinstance(ctx, BaseModel):
            return ctx.model_dump_json()
        if isinstance(ctx, dict):
            return json.dumps(ctx)
        try:
            return json.dumps(ctx.__dict__)
        except Exception:
            return json.dumps(ctx)

    def _deserialize_context(self, s: str) -> Any:
        if not s or s == "{}":
            if self.context_type and callable(self.context_type):
                try:
                    return self.context_type()
                except Exception:
                    pass
            return {}
        try:
            data = json.loads(s)
            if self.context_type and isinstance(data, dict):
                if isinstance(self.context_type, type) and issubclass(self.context_type, BaseModel):
                    return self.context_type.model_validate(data)
                if dataclasses.is_dataclass(self.context_type):
                    return self.context_type(**data)
            return data
        except Exception:
            return {}
