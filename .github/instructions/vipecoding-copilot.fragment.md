<!-- Fragment: append to consumer .github/copilot-instructions.md if appropriate. -->

## Vipecoding pack (submodule)

This project may include `vendor/agents-skills` (or similar) with enterprise prompts under `github/prompts/`. When assisting with code:

- Apply **security-redlines** rules from `github/prompts/security-redlines.md` (no secrets, respect PII and licenses).
- Prefer stack-specific implementer prompts when the stack is TypeScript + React, TypeScript + Node.js, Java + Spring Boot, or Python + FastAPI.
