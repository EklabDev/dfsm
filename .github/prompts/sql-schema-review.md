# Prompt: sql-schema-review

**Skill id:** `sql-schema-review`

Review relational migrations, indexing, and constraints.

---

SQL schema review

## When to use
Schema or migration change.

## MUST
- Check backward compatibility and deploy order.
- Index coverage for new query patterns; avoid silent table locks.
- FKs, cascades, and nullability explicit.

## Verification
- [ ] Rollback or expand/contract plan stated
- [ ] Data volume / lock risk considered
