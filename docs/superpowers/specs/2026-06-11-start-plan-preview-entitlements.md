# Start Plan Preview Entitlements

## Problem

`client/configs.configs.startPlanPreview.entitlements` returns one entitlement per model. The Trial plan card previously collapsed those entries into a single quota summary and a slash-joined model string, so a multi-model trial plan could hide part of the entitlement detail.

## Expected Behavior

- The Start Plan entry remains visible for disconnected users, but the Trial plan card is shown only when `client/configs.configs.startPlanPreview` exists and contains displayable entitlements.
- The Trial plan card uses the remote `startPlanPreview.name` as its title.
- The purchased Start Plan status card title stays `Start Plan` when the active entitlement name is a Start entitlement such as `Start` or `ZCode V3 Start Plan`.
- If a paid Coding Plan entitlement is temporarily rendered through the Start Plan provider branch, the status card title uses the entitlement/product name instead of the hardcoded `Start Plan`, so paid Coding Plan users see their actual plan name.
- Every displayable `model_usage` entitlement with a positive `grantUnits` and non-empty `showName` contributes its model name to the supported model list.
- The hero quota is the sum of all displayed entitlement `grantUnits` with the same unit and period, and is shown once as the Trial plan total. The English hero uses long compact wording such as `5 Million tokens per day`; the Chinese hero stays localized compact such as `500万 tokens/日`.
- The detail sentence keeps compact token units and groups models by equal `grantUnits`: in English, if all models have the same quota, show `Daily quota · GLM-5.2 / GLM-5-Turbo 10M each`; if one model differs, show `Daily quota · GLM-5.2 30M · GLM-5-Turbo 10M`; Chinese uses `万` / `亿`.
- If remote `startPlanPreview` is missing, the Trial plan card is not rendered and no local hardcoded quota copy is used.

## Compatibility

- This is UI-only and does not change provider, stream, runtime, or remote-control behavior.
- Layout must wrap naturally on desktop and mobile web, and continue using semantic theme tokens from `DESIGN.md`.
