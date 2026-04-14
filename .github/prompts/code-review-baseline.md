# Prompt: code-review-baseline

**Skill id:** `code-review-baseline`

Review PRs for clarity, correctness, test gaps, and security smells before merge.

---

Code review baseline

## When to use
Pull request or diff review.

## MUST
- Check correctness, edge cases, and error handling.
- Flag injection risks, authz gaps, and secret leaks.
- Require tests or justify waiver per team policy.
- Keep comments constructive and specific.

## Verification
- [ ] Risk summary and severity noted
- [ ] Test or follow-up ticket referenced
