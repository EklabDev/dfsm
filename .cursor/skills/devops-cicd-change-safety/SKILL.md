---
name: devops-cicd-change-safety
description: Pipeline and infra edits with environment gates.
license: MIT
compatibility: Cursor skills; Vipecoding submodule pack.
metadata:
  skillId: devops-cicd-change-safety
  version: "1.0"
---

# DevOps CI/CD change safety

## When to use
CI/CD, IaC, or cluster change.

## MUST
- Require explicit target environment; forbid silent prod changes.
- Plan canary/rollback; protect secrets via CI secret stores.
- Align with security-redlines for third-party actions.

## Verification
- [ ] Change ticket references environments and approvals
