# Media Budget Error I18n

## Context

Model request media-budget validation runs in the CLI/runtime before provider
submission. Its messages can surface in the UI through `ChatErrorBanner`, so
user-facing presentation must not depend on the runtime's English fallback
message.

## Contract

- Runtime keeps `CoreErrorType.InvalidInput` for current-user media that exceeds
  a protected media budget.
- Runtime uses `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE` whenever current-user
  attachments exceed the shared 40 MiB encoded-media budget, including image,
  PDF, file, video, or mixed attachments.
- UI retains the previous codes for errors persisted by older runtimes:
  - `MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE`
  - `MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE`
- UI maps all three stable codes through `zcode.error.*` locale entries in the
  shared desktop and mobile Web banner; transport and recovery semantics are unchanged.
- Telemetry classifies all three codes as `runtime / invalid_input`; it must not rely
  on English-only message matching.

## Non-Goals

- Provider-visible media omission placeholders remain English provider-facing
  text and are not localized.
- Single oversized local video attachment path-reference downgrade is unchanged.
