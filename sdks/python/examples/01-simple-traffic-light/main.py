from __future__ import annotations

import asyncio
from dataclasses import dataclass

from dfsm import DfsmActor, FSMRegistry, parse_yaml_machine


@dataclass
class TrafficContext:
    cycle_count: int = 0


async def main() -> None:
    print("=== DFSM Python Example 01: Simple Traffic Light ===")

    yaml_str = """
dfsm: "1.0"
id: "traffic-light"
version: "1.0.0"
description: "Simple traffic light state machine in Python"
initial: "red"
states:
  red:
    on:
      TIMER: "green"
  green:
    on:
      TIMER: "yellow"
  yellow:
    on:
      TIMER: "red"
      OFF: "off"
  off:
    type: "final"
"""

    machine = parse_yaml_machine(yaml_str)
    reg = FSMRegistry()
    actor = DfsmActor[TrafficContext](machine, reg)
    tx_id = "traffic-light-1"

    # 1. red -> green
    res1 = await actor.transition(tx_id, "TIMER")
    print(f"[1] red -> {res1.current_state} (Event: {res1.event_name})")

    # 2. green -> yellow
    res2 = await actor.transition(tx_id, "TIMER")
    print(f"[2] green -> {res2.current_state} (Event: {res2.event_name})")

    # 3. yellow -> off (Final state)
    res3 = await actor.transition(tx_id, "OFF")
    print(f"[3] yellow -> {res3.current_state} (Final State! Status: {res3.status.value})")

    state = await actor.get_state(tx_id)
    print(f"Final Status: {state.status.value} | State: {state.current_state}")


if __name__ == "__main__":
    asyncio.run(main())

