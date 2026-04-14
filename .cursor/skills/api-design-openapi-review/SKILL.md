---
name: api-design-openapi-review
description: Design or review HTTP APIs with OpenAPI-first rigor.
license: MIT
compatibility: Cursor skills; Vipecoding submodule pack.
metadata:
  skillId: api-design-openapi-review
  version: "1.0"
---

# API design and OpenAPI review

## When to use
New API surface or breaking change.

## MUST
- Prefer explicit schemas, error models, versioning, and pagination patterns.
- Document authn/authz assumptions per operation.
- Call out idempotency and rate limiting where needed.

## Verification
- [ ] OpenAPI or equivalent artifact updated
- [ ] Breaking changes flagged for consumers
