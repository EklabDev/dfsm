# Prompt: qa-test-planning-first-wave

**Skill id:** `qa-test-planning-first-wave`

Plan and verify tests for TypeScript+React, TypeScript+Node, Java+Spring Boot, Python+FastAPI.

---

QA test planning (first-wave stacks)

## When to use
Feature or bugfix needs test strategy.

## MUST
- Name environments (dev/UAT/prod) for any data or deployment steps.
- Choose pyramid-appropriate tests (unit, integration, e2e) for the stack.
- For TS+React: component and hook tests; a11y spot-checks where relevant.
- For TS+Node / Java Spring / FastAPI: API contract tests and failure modes.

## Verification
- [ ] Test cases trace to acceptance criteria
- [ ] Flake-prone areas called out
