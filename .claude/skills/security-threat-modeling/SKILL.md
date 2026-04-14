---
name: security-threat-modeling
description: Lightweight STRIDE-style thinking complementing security-redlines.
license: MIT
compatibility: Claude Code skills; Vipecoding submodule pack.
metadata:
  skillId: security-threat-modeling
  version: "1.0"
---

# Security threat modeling

## When to use
New trust boundary, auth change, or sensitive data flow.

## MUST
- Identify assets, actors, entry points, and threats.
- Map mitigations to controls; do not contradict security-redlines.
- Escalate residual risk with owners.

## Verification
- [ ] Threats and mitigations documented for the change
