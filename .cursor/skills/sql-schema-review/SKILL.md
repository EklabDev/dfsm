---
name: sql-schema-review
description: Review relational migrations, indexing, and constraints.
license: MIT
compatibility: Cursor skills; Vipecoding submodule pack.
metadata:
  skillId: sql-schema-review
  version: "1.0"
---

# SQL schema review

## When to use
Schema or migration change.

## MUST
- Check backward compatibility and deploy order.
- Index coverage for new query patterns; avoid silent table locks.
- FKs, cascades, and nullability explicit.

## Verification
- [ ] Rollback or expand/contract plan stated
- [ ] Data volume / lock risk considered
