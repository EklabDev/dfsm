# Prompt: nosql-modeling-review

**Skill id:** `nosql-modeling-review`

Review document, key-value, or event models for access patterns and consistency.

---

NoSQL modeling review

## When to use
NoSQL schema or topic design.

## MUST
- Optimize for known access patterns; avoid unbounded hot partitions.
- Document consistency model (strong, eventual) and conflict handling.
- Retention, TTL, and PII placement explicit.

## Verification
- [ ] Read/write paths and failure modes listed
