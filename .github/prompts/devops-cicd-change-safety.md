# Prompt: devops-cicd-change-safety

**Skill id:** `devops-cicd-change-safety`

Pipeline and infra edits with environment gates.

---

DevOps CI/CD change safety

## When to use
CI/CD, IaC, or cluster change.

## MUST
- Require explicit target environment; forbid silent prod changes.
- Plan canary/rollback; protect secrets via CI secret stores.
- Align with security-redlines for third-party actions.

## Verification
- [ ] Change ticket references environments and approvals
