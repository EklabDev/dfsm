---
name: nosql-modeling-review
description: Review document, key-value, or event models for access patterns and consistency.
license: MIT
compatibility: Claude Code skills; Vipecoding submodule pack.
metadata:
  skillId: nosql-modeling-review
  version: "1.0"
---

# NoSQL modeling review

## When to use
NoSQL schema or topic design.

## MUST
- Optimize for known access patterns; avoid unbounded hot partitions.
- Document consistency model (strong, eventual) and conflict handling.
- Retention, TTL, and PII placement explicit.

## Verification
- [ ] Read/write paths and failure modes listed
