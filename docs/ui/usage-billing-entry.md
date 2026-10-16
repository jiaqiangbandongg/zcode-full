# Usage Billing Entry

## Overview

The app exposes usage and billing from the same places users already check account state:

- the workspace sidebar shows a compact Z.AI credits banner above the profile footer;
- the profile dropdown shows a lightweight last-30-days usage summary after login;
- the settings sidebar always includes `Usage`, with a purchase banner at the top of the detailed usage page.

## Behavior

- `Buy credits` opens the Z.AI console in the platform browser via `IPlatformService.openExternal`.
- `API keys` opens the existing Z.AI API key console.
- `Usage details` routes to the settings `usage` section through `setPendingSettingsSection("usage")` when opened from the workspace sidebar, or switches the active settings section directly when already inside settings.

The UI is intentionally compact and uses existing semantic tokens (`bg-card`, `bg-surface`, `text-foreground-subtle`, `bg-accent`) so the entry works across desktop, web, mobile web, light, dark, and Zai themes.
