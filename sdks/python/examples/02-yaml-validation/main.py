from __future__ import annotations

import asyncio
from typing import Any

from pydantic import BaseModel, Field

from dfsm import DfsmActor, FSMRegistry, TransitionRequest, parse_yaml_machine


class DepositInput(BaseModel):
    amount: int = Field(gt=0, description="Deposit amount must be positive")
    email: str = Field(pattern=r"^[\w\.-]+@[\w\.-]+\.\w+$")


class AccountContext(BaseModel):
    account_id: str = ""
    email: str = ""
    balance: int = 0


async def main() -> None:
    print("=== DFSM Python Example 02: Input & Schema Validation ===")

    yaml_str = """
dfsm: "1.0"
id: "account-verification"
version: "1.0.0"
initial: "unverified"
states:
  unverified:
    on:
      DEPOSIT:
        target: "active"
        transition: "handleDeposit"
  active:
    on:
      FREEZE: "frozen"
  frozen:
    type: "final"
"""

    machine = parse_yaml_machine(yaml_str)
    reg = FSMRegistry()

    async def handle_deposit(req: TransitionRequest) -> Any:
        dep = DepositInput(**req.input)
        ctx = AccountContext(**req.context)
        ctx.email = dep.email
        ctx.balance += dep.amount
        print(f">> Handled Deposit: Added ${dep.amount} for {dep.email} (New Balance: ${ctx.balance})")
        return ctx.model_dump()

    reg.register_transition("handleDeposit", handle_deposit)
    actor = DfsmActor[AccountContext](machine, reg)

    # 1. Invalid input: amount <= 0
    try:
        await actor.transition("acc-fail-amount", "DEPOSIT", {"amount": 0, "email": "valid@eklab.dev"})
    except Exception as e:
        print(f"[Expected Failure 1]: {e}")

    # 2. Invalid input: bad email
    try:
        await actor.transition("acc-fail-email", "DEPOSIT", {"amount": 50, "email": "invalid-email"})
    except Exception as e:
        print(f"[Expected Failure 2]: {e}")

    # 3. Valid input
    res = await actor.transition("acc-valid-1", "DEPOSIT", {"amount": 100, "email": "owner@eklab.dev"})
    print(f"[Success]: Transitioned to {res.current_state}")

    # 4. Schema validation error with invalid YAML missing required fields
    bad_yaml = """
dfsm: "1.0"
id: "missing-states"
initial: "start"
"""
    try:
        parse_yaml_machine(bad_yaml)
    except Exception as e:
        print(f"[Expected Schema Error]: {e}")


if __name__ == "__main__":
    asyncio.run(main())

