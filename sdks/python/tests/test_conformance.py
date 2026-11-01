from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from dfsm import (
    CompensationRequest,
    DfsmActor,
    FSMRegistry,
    PartialTransitionPolicy,
    PolicyMerger,
    StateValue,
    TransitionRequest,
    parse_yaml_machine,
)


@pytest.mark.asyncio
async def test_canonical_conformance_suite() -> None:
    suite_path = Path(__file__).resolve().parents[3] / "spec" / "conformance" / "conformance-suite.json"
    with open(suite_path, "r", encoding="utf-8") as f:
        suite = json.load(f)

    machines_dir = suite_path.parent

    for scenario in suite["scenarios"]:
        print(f"\n=== Running Python Scenario: {scenario['id']} - {scenario['description']} ===")

        yaml_file = machines_dir / scenario["file"]
        with open(yaml_file, "r", encoding="utf-8") as yf:
            yaml_content = yf.read()

        machine = parse_yaml_machine(yaml_content)
        reg = FSMRegistry()
        compensation_log: List[str] = []

        # Handlers that return context updates
        def make_record_step(name: str):
            async def handler(req: TransitionRequest) -> Any:
                ctx = dict(req.context) if isinstance(req.context, dict) else {}
                if req.input and isinstance(req.input, dict):
                    ctx.update(req.input)
                return ctx
            return handler

        for tx_name in [
            "conformance.traffic.recordStep",
            "conformance.hierarchy.beginAuth",
            "conformance.hierarchy.markCancelled",
            "conformance.hierarchy.captureFunds",
            "conformance.parallel.initFulfillment",
            "conformance.parallel.recordPaid",
            "conformance.parallel.recordPacked",
            "conformance.saga.bookFlight",
            "conformance.saga.bookHotel",
        ]:
            reg.register_transition(tx_name, make_record_step(tx_name))

        # Failure handlers
        for fail_name in [
            "conformance.traffic.brokenBulb",
            "conformance.resilience.callPrimary",
            "conformance.resilience.alwaysFail",
            "conformance.saga.bookCar",
        ]:
            def make_fail(fn_name: str):
                async def fail_handler(req: TransitionRequest) -> Any:
                    should_fail = True
                    if req.input and isinstance(req.input, dict):
                        if "fail" in req.input and not req.input["fail"]:
                            should_fail = False
                    if should_fail:
                        raise RuntimeError(f"Simulated failure in {fn_name}")
                    ctx = dict(req.context) if isinstance(req.context, dict) else {}
                    if req.input and isinstance(req.input, dict):
                        ctx.update(req.input)
                    return ctx
                return fail_handler

            pol_override = None
            if "decoratorOverrides" in scenario:
                dec = scenario["decoratorOverrides"]
                if fail_name in dec:
                    ov = dec[fail_name]
                    if "retry" in ov and "maxAttempts" in ov["retry"]:
                        pol_override = PartialTransitionPolicy(
                            retry_max_attempts=int(ov["retry"]["maxAttempts"]),
                            retry_defined=True,
                        )

            reg.register_transition(fail_name, make_fail(fail_name), pol_override)

        # Compensations
        for comp_name in [
            "conformance.saga.cancelFlight",
            "conformance.saga.cancelHotel",
            "conformance.saga.cancelCar",
        ]:
            def make_comp(cn: str):
                async def comp_handler(req: CompensationRequest) -> None:
                    compensation_log.append(cn)
                return comp_handler
            reg.register_compensate(comp_name, make_comp(comp_name))

        # Dummy effects
        for eff_name in [
            "conformance.traffic.onEnterRed",
            "conformance.traffic.onExitRed",
            "conformance.parallel.notifyShipped",
            "conformance.resilience.alertError",
        ]:
            reg.register_effect(eff_name, lambda req: None)

        # Scenario 5: Policy merge check
        if scenario["id"] == "policy-merge-decorator-precedence-and-fallback":
            dec_retry = None
            if "decoratorOverrides" in scenario:
                dec = scenario["decoratorOverrides"]
                if "conformance.resilience.callPrimary" in dec:
                    cp = dec["conformance.resilience.callPrimary"]
                    if "retry" in cp and "maxAttempts" in cp["retry"]:
                        dec_retry = cp["retry"]["maxAttempts"]

            ready_node = machine.states.get("ready")
            trans_pol = None
            if ready_node and "CALL_PRIMARY" in ready_node.on:
                first_edge = ready_node.on["CALL_PRIMARY"][0]
                trans_pol = first_edge.to_partial_policy()

            merged = PolicyMerger.merge([
                PartialTransitionPolicy(retry_max_attempts=dec_retry, retry_defined=dec_retry is not None),
                trans_pol,
                machine.defaults,
                None,
            ])

            if "expectedEffectiveMaxAttempts" in scenario:
                assert merged.retry.max_attempts == scenario["expectedEffectiveMaxAttempts"]
            if "expectedEffectiveCircuitBreakerEnabled" in scenario:
                assert merged.circuit_breaker is not None
                assert merged.circuit_breaker.enabled == scenario["expectedEffectiveCircuitBreakerEnabled"]

        actor = DfsmActor(machine, reg)
        tx_id = f"tx-{scenario['id']}"

        # Run steps
        if "steps" in scenario:
            for step in scenario["steps"]:
                res = await actor.transition(tx_id, step["event"], step.get("input"))
                expected_sv = StateValue.from_json(step["expectedState"])
                assert res.current_state == expected_sv, (
                    f"State mismatch for event '{step['event']}': got {res.current_state}, expected {expected_sv}"
                )
                if "expectedStatus" in step:
                    assert res.status.value == step["expectedStatus"], (
                        f"Status mismatch for event '{step['event']}': got {res.status.value}, expected {step['expectedStatus']}"
                    )

        # Verify compensation order
        if "expectedCompensationOrder" in scenario:
            assert compensation_log == scenario["expectedCompensationOrder"]
