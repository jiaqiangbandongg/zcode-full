# Sidebar Footer Plan Badge

## Goal

The workspace sidebar footer shows the signed-in account name. When the account has an active Coding Plan entitlement, the opened account menu appends a compact account-level plan badge after the account name in its header. The sidebar footer trigger itself shows only the avatar and account name, without a plan badge.

## Behavior

- The badge is visible only for signed-in users with an active Coding Plan entitlement.
- The badge no longer follows the current workspace connection mode. API Key, Start Plan, native provider, or Team Plan selection state must not hide an account-level personal Coding Plan badge.
- If the account has an active personal Coding Plan, the badge shows the personal plan label.
- If the account has no active personal Coding Plan but has a subscribed Team Plan, the badge shows `Team` / `团队`.
- If the account has both personal and Team Plan entitlements, the personal Coding Plan wins.
- The personal badge prefers `quota.level` as the label. If the quota level is unavailable, it falls back to the first subscription product name.
- Long product names are normalized for footer density by dropping the `GLM Coding` prefix when present.
- The account name remains the primary text and keeps truncation priority; the badge is compact and may shrink away before it pushes footer controls out of bounds.
- The badge uses semantic surface, border, and foreground tokens so it works in light and dark themes.

## Non-goals

- The badge does not open a new UI by itself. The avatar menu remains the entry point for upgrade actions; usage details live in the Usage page and chat input context panel.
- The badge does not introduce new user/account fields. Personal state continues to come from Coding Plan entitlement data; Team state comes from subscribed enterprise Coding Plan products.
