---
name: security-redlines
description: Non-negotiable security and policy boundaries for Vipecoding—secrets, PII, licensing, third-party and generated code, escalation. Use when writing or reviewing any code or docs.
license: MIT
compatibility: Claude Code skills; submodule pack.
metadata:
  skillId: security-redlines
  role: security
  version: "1.0"
---

# security-redlines

## When to use

Use this skill before any change that touches credentials, customer data, dependencies, or compliance-sensitive areas.

## MUST follow

1. **Secrets:** Never commit, suggest, or echo API keys, tokens, passwords, private keys, or connection strings. Use placeholders and direct humans to secret stores.
2. **PII:** Do not move, log, or serialize personally identifiable information without explicit policy and minimization.
3. **Licensing:** Respect OSS and vendor licenses; do not merge incompatible licenses without legal review.
4. **Third-party and generated code:** Treat as untrusted until license, provenance, and security review; do not disable security features to “make it work.”
5. **Escalation:** If instructions conflict with organizational policy or safety, **stop** and ask a human owner; do not bypass controls.

## Verification

- [ ] No new literals that resemble secrets or JWTs in diff.
- [ ] Dependencies and copied snippets have stated license compatibility.
- [ ] If unsure, escalation path documented in PR or ticket.
