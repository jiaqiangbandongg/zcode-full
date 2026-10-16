Retrieved for possible relevance — use only if it actually applies to what the user asked.

Memory: <MEMORY_ROOT>/database-test-policy.md:

---
name: database-test-policy
description: Database tests must use the real database rather than mocks.
metadata:
  type: feedback
---

Use the real database for database tests; mocked database tests are not trusted.

**Why:** A prior mocked test passed while production migration behavior failed.

**How to apply:** Use the real database for database integration tests.
