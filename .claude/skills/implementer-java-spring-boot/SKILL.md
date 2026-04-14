---
name: implementer-java-spring-boot
description: Spring Boot services: configuration, web layer, data access.
license: MIT
compatibility: Claude Code skills; Vipecoding submodule pack.
metadata:
  skillId: implementer-java-spring-boot
  version: "1.0"
---

# Implementer: Java + Spring Boot

## When to use
Spring Boot feature or bugfix.

## MUST
- Use Spring security defaults; avoid disabling CSRF/CORS without review.
- Transactions and repository boundaries explicit.
- Apply security-redlines for secrets and PII.

## Verification
- [ ] Appropriate tests (slice/integration) identified
