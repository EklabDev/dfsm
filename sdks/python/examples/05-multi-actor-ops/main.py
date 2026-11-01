from __future__ import annotations

import asyncio
from dataclasses import dataclass

from dfsm import (
    DfsmActor,
    FSMRegistry,
    ForceCleanUpAction,
    ForceCleanUpOptions,
    MemoryStateStore,
    RealClock,
    StateValue,
    TransactionRecord,
    TransactionStatus,
    parse_yaml_machine,
)


@dataclass
class WorkerContext:
    task_id: str = ""


async def main() -> None:
    print("=== DFSM Python Example 05: Multi-Actor Ops & Sweep ===")

    yaml_str = """
dfsm: "1.0"
id: "worker-job"
version: "1.0.0"
initial: "queued"
states:
  queued:
    on:
      DISPATCH: "processing"
  processing:
    on:
      COMPLETE: "done"
      FAIL: "failed"
  done:
    type: "final"
  failed:
    type: "final"
"""

    machine = parse_yaml_machine(yaml_str)
    store = MemoryStateStore()
    reg = FSMRegistry().with_store(store)
    actor = DfsmActor[WorkerContext](machine, reg)

    # 1. Create a set of transactions
    await actor.transition("job-1", "DISPATCH")
    await actor.transition("job-1", "COMPLETE")  # completed

    await actor.transition("job-2", "DISPATCH")  # processing (in-flight)

    await actor.transition("job-3", "DISPATCH")
    await actor.transition("job-3", "FAIL")  # failed

    # Simulate an older stuck job created 1 hour ago
    now = RealClock().now_ms()
    orphan = TransactionRecord(
        transaction_id="job-stuck-orphan",
        machine_id="worker-job",
        current_state=StateValue.leaf("processing"),
        status=TransactionStatus.IN_FLIGHT,
        context_json="{}",
        version=1,
        created_at=now - 3600000,
        updated_at=now - 3600000,
    )
    await store.create_transaction(orphan)

    # 2. Query Status Breakdown
    breakdown = await actor.get_status_breakdown()
    print(
        f"[Status Breakdown]: Idle={breakdown.idle}, InFlight={breakdown.in_flight}, "
        f"Completed={breakdown.completed}, Failed={breakdown.failed}"
    )

    # 3. Query InFlightSummary
    summary = await actor.get_in_flight_summary()
    print(
        f"[InFlight Summary]: Total In-Flight={summary.total_in_flight} | "
        f"Non-Terminal Count={summary.non_terminal_count} | Terminal States={summary.terminal_states}"
    )

    # 4. Force Cleanup of stuck jobs (> 30 mins old)
    clean_res = await actor.force_cleanup(
        ForceCleanUpOptions(
            older_than_ms=1800000,
            stuck_only=True,
            action=ForceCleanUpAction.MARK_FAIL,
        )
    )
    print(
        f"[Ops Cleanup]: Processed {clean_res.processed_count} stuck job(s): "
        f"{clean_res.affected_transaction_ids} marked as FAILED"
    )

    # 5. Query updated breakdown
    updated = await actor.get_status_breakdown()
    print(
        f"[Updated Breakdown]: InFlight={updated.in_flight}, "
        f"Completed={updated.completed}, Failed={updated.failed}"
    )


if __name__ == "__main__":
    asyncio.run(main())

