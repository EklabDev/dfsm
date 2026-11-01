from __future__ import annotations

import asyncio
from dataclasses import dataclass

from dfsm import DfsmActor, FSMRegistry, parse_yaml_machine


@dataclass
class FulfillmentContext:
    tracking_number: str = ""
    invoice_id: str = ""


async def main() -> None:
    print("=== DFSM Python Example 03: Parallel Regions & onDone ===")

    yaml_str = """
dfsm: "1.0"
id: "fulfillment-process"
version: "1.0.0"
initial: "fulfilling"
states:
  fulfilling:
    type: "parallel"
    onDone: "completed"
    states:
      shipping:
        initial: "pending"
        states:
          pending:
            on:
              SHIP: "dispatched"
          dispatched:
            type: "final"
      billing:
        initial: "unpaid"
        states:
          unpaid:
            on:
              PAY: "settled"
          settled:
            type: "final"
  completed:
    type: "final"
"""

    machine = parse_yaml_machine(yaml_str)
    reg = FSMRegistry()
    actor = DfsmActor[FulfillmentContext](machine, reg)
    tx_id = "order-fulfillment-1"

    # 1. Start parallel transaction
    init_state = await actor.start(tx_id)
    print(f"Initial State: {init_state.current_state}")

    # 2. Advance shipping region
    res1 = await actor.transition(tx_id, "SHIP")
    print(f"[1] SHIP -> {res1.current_state} (Status: {res1.status.value})")

    # 3. Advance billing region -> triggers onDone -> completed!
    res2 = await actor.transition(tx_id, "PAY")
    print(f"[2] PAY -> {res2.current_state} (Status: {res2.status.value} - onDone triggered!)")

    final_state = await actor.get_state(tx_id)
    print(f"Final Transaction State: {final_state.current_state} | Status: {final_state.status.value}")


if __name__ == "__main__":
    asyncio.run(main())

