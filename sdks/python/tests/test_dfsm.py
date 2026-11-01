from __future__ import annotations

import asyncio
from typing import Any

import pytest

from dfsm import (
    CircuitBreakerInstance,
    CircuitBreakerPolicy,
    CircuitState,
    DfsmActor,
    FSMRegistry,
    ForceCleanUpAction,
    ForceCleanUpOptions,
    HookType,
    MemoryStateStore,
    PartialTransitionPolicy,
    PolicyMerger,
    RealClock,
    StateValue,
    TransactionStatus,
    VirtualClock,
    parse_yaml_machine,
)


def test_state_value_serialization() -> None:
    leaf = StateValue.leaf("idle")
    assert leaf.is_leaf()
    assert not leaf.is_compound()
    assert str(leaf) == "idle"
    assert leaf.to_json() == "idle"

    compound = StateValue.compound({
        "shipping": StateValue.leaf("pending"),
        "billing": StateValue.leaf("unpaid"),
    })
    assert compound.is_compound()
    assert not compound.is_leaf()
    assert compound.to_json() == {"billing": "unpaid", "shipping": "pending"}

    # Round trip
    parsed = StateValue.from_json(compound.to_json())
    assert parsed == compound


def test_circuit_breaker_transitions() -> None:
    vclock = VirtualClock(1000)
    policy = CircuitBreakerPolicy(
        enabled=True,
        failure_threshold=2,
        recovery_timeout_ms=100,
        half_open_success_threshold=1,
    )
    cb = CircuitBreakerInstance(policy, vclock)

    assert cb.state == CircuitState.CLOSED
    cb.before_execution("testHandler")

    # 1st failure
    cb.on_failure()
    assert cb.state == CircuitState.CLOSED

    # 2nd failure -> Trips OPEN
    cb.on_failure()
    assert cb.state == CircuitState.OPEN

    # Rejected while OPEN
    with pytest.raises(Exception) as exc_info:
        cb.before_execution("testHandler")
    assert "Circuit breaker OPEN" in str(exc_info.value)

    # Advance virtual clock past recovery timeout
    vclock.advance(120)

    # Request probe transitions to HALF_OPEN
    cb.before_execution("testHandler")
    assert cb.state == CircuitState.HALF_OPEN

    # Success closes circuit
    cb.on_success()
    assert cb.state == CircuitState.CLOSED


def test_policy_merger_precedence() -> None:
    code_policy = PartialTransitionPolicy(retry_max_attempts=4, retry_defined=True)
    trans_policy = PartialTransitionPolicy(
        retry_max_attempts=3,
        retry_defined=True,
        cb_enabled=True,
        cb_failure_threshold=3,
        cb_defined=True,
    )
    def_policy = PartialTransitionPolicy(
        retry_max_attempts=2,
        retry_defined=True,
        on_fail_target="error_queue",
        on_fail_defined=True,
    )

    merged = PolicyMerger.merge([code_policy, trans_policy, def_policy, None])

    # Code takes precedence for retry
    assert merged.retry.max_attempts == 4

    # Transition defines circuit breaker
    assert merged.circuit_breaker is not None
    assert merged.circuit_breaker.failure_threshold == 3

    # Machine defaults defines onFail target
    assert merged.on_fail is not None
    assert merged.on_fail.target == "error_queue"


@pytest.mark.asyncio
async def test_lifecycle_hooks_and_actor_execution() -> None:
    yaml_str = """
dfsm: "1.0"
id: test-lifecycle
initial: start

states:
  start:
    on:
      SUBMIT:
        target: finished
        transition: doWork
  finished:
    type: final
"""
    machine = parse_yaml_machine(yaml_str)
    reg = FSMRegistry().with_store(MemoryStateStore())

    hook_counts = {h: 0 for h in HookType}

    for h in HookType:
        def make_hook(ht: HookType):
            async def h_fn(ev: Any):
                hook_counts[ht] += 1
            return h_fn
        reg.register_hook(h, make_hook(h))

    async def do_work(req: Any) -> Any:
        ctx = dict(req.context) if isinstance(req.context, dict) else {}
        ctx["done"] = True
        return ctx

    reg.register_transition("doWork", do_work)

    actor = DfsmActor(machine, reg)
    tx_id = "tx-lifecycle-1"

    res = await actor.transition(tx_id, "SUBMIT", {"param": 42})
    assert res.current_state == StateValue.leaf("finished")
    assert res.status == TransactionStatus.COMPLETED

    assert hook_counts[HookType.BEFORE_TRANSITION] == 1
    assert hook_counts[HookType.AFTER_TRANSITION] == 1
    assert hook_counts[HookType.ON_COMPLETE] == 1
    assert hook_counts[HookType.ON_TERMINAL] == 1


@pytest.mark.asyncio
async def test_ops_monitoring_and_cleanup() -> None:
    yaml_str = """
dfsm: "1.0"
id: test-ops
initial: pending

states:
  pending:
    on:
      ADVANCE: active
  active:
    on:
      DONE: completed
      FAIL: failed
  completed:
    type: final
  failed:
    type: final
"""
    machine = parse_yaml_machine(yaml_str)
    store = MemoryStateStore()
    reg = FSMRegistry().with_store(store)
    actor = DfsmActor(machine, reg)

    # tx-1 -> active
    await actor.transition("tx-1", "ADVANCE")

    # tx-2 -> completed
    await actor.transition("tx-2", "ADVANCE")
    await actor.transition("tx-2", "DONE")

    summary = await actor.get_in_flight_summary()
    assert summary.non_terminal_count == 1  # tx-1 is active
    assert "completed" in summary.terminal_states
    assert "failed" in summary.terminal_states

    # Cleanup stuck tx-1
    cleaned = await actor.force_cleanup(
        ForceCleanUpOptions(
            transaction_ids=["tx-1"],
            action=ForceCleanUpAction.MARK_FAIL,
        )
    )
    assert cleaned.processed_count == 1

    summary_after = await actor.get_in_flight_summary()
    assert summary_after.non_terminal_count == 0

