# Model Provider Coding Plan

Model Providers now separate manual API Key access from account-based Coding Plan access.

## Entries

- `Z.AI - API Key` and `BigModel - API Key` keep the existing provider form, including API Key, endpoints, models, and model mappings.
- `Z.AI - Coding Plan` and `BigModel - Coding Plan` are independent entries. They use their own `*-coding-plan` provider credential to query the usage quota entitlement API, then derive whether the account has Coding Plan access.
- Provider ids are intentionally separate:
  - `builtin:zai` => `Z.AI - API Key`
  - `builtin:zai-coding-plan` => `Z.AI - Coding Plan`
  - `builtin:bigmodel` => `BigModel - API Key`
  - `builtin:bigmodel-coding-plan` => `BigModel - Coding Plan`
- The provider sidebar groups preset entries into provider cards:
  - `Z.AI`: `Coding Plan`, `API Key`
  - `BigModel`: `Coding Plan`, `API Key`

## Coding Plan States

- Not connected: the matching Coding Plan provider is not configured. The page shows the lightweight account connection card and vertical Lite / Pro / Max plan cards.
- Connected but not subscribed: the matching Coding Plan provider is configured, but the quota entitlement API returns `no_plan` or no usable plan data. The page keeps the plan cards and shows only the subscribe action.
- Subscribed: the matching Coding Plan provider is configured and the quota entitlement API returns subscription or quota data. The page shows the normal provider configuration in this order: name, Coding Plan status card, endpoints, models, and model mapping. It does not show API Key or Connection Mode fields.

The Coding Plan status is refreshed after provider load, manual refresh, and saving `builtin:zai-coding-plan` or `builtin:bigmodel-coding-plan`. Users who need to paste a key manually should use the API Key entries instead.

When an entitlement refresh is in flight, the settings page keeps displaying an existing valid paid Coding Plan quota snapshot for the same provider. This matches the sidebar usage entry: cached valid entitlement is treated as the current visible state until the background refresh returns, instead of temporarily falling back to Start Plan or an empty checking state.

Manual refresh in Model Provider settings is an account entitlement refresh, not
only a provider catalog refresh. It must refresh OAuth-derived Coding Plan API
keys, personal Coding/Start entitlement snapshots, and authenticated Team Plan
pricing/customer project data. This covers users being added to a team, removed
from a team, and team purchases completed while the app is already open.

The purchase success page keeps a single `Done` action. It must not show a
separate immediate refresh button. Clicking `Done` completes the purchase flow
by running the outer purchase-complete refresh chain first, then closing the
panel. That refresh chain is responsible for making the new personal or Team
Plan entitlement visible in Model Provider settings.

## Pricing Cards

- Pricing cards are provider-specific. Z.AI uses the Z.AI USD Coding Plan catalog; BigModel uses the BigModel CNY GLM Coding catalog.
- The visible periods are `Monthly`, `Quarterly`, and `Yearly`. Non-monthly periods show the billed period amount plus the monthly equivalent.
- Plan descriptions are also provider-specific, so BigModel wording is not reused from the Z.AI catalog.

## Signed-out Purchase Choice

When BigModel account-based access is disconnected, the purchase choice banners
show For Individuals and For Teams entries before the user opens the full
purchase panel.
Each entry must include the same price hierarchy used by the plan list, placed
between the title and description:

- For Individuals: `¥49.00 人民币 起`
- For Teams: `¥598.00 人民币 起`

The amount formatting must reuse the shared Coding Plan amount formatter so
Chinese and non-Chinese locales keep the same currency semantics as the package
list.

When `client/configs.codingPlanBillingDiscount` is active, the activity is
announced by the purchase panel banner and upgrade action only. The settings
Plan Card title must not show a separate 150% quota badge, because the banner is
the single source of campaign promotion.

The compact Coding Plan usage panel inside a conversation must not render the
150% quota campaign badge. That panel prioritizes quota values, reset timing,
and reset actions within a narrow surface; campaign promotion remains available
from the Model Provider and purchase surfaces.

The signed-out purchase choice banners are acquisition entries rather than Plan
Card status. When the billing discount is active, the signed-out For Individuals
and For Teams entries both show the compact 150% quota badge next to the title.
Logged-in not-subscribed entries and logged-in enterprise team group entries do
not show this badge.

When Z.ai account-based access is disconnected and no Start/Coding entitlement
is available yet, the same signed-out surface is still shown, but only the Start
entry (when `startPlanPreview` exists) and For Individuals entry are visible.
For Teams is hidden for Z.ai.

The purchase panel follows the same product boundary. When the selected provider
does not support For Teams, such as Z.ai, the panel renders the Individuals plan
content directly and does not show Individuals/Teams audience tabs.
This no-tabs branch must still fill the available panel body height so the plan
cards keep the same stretched layout as the tabbed BigModel view.

When the account state is disconnected, clicking For Individuals or For Teams
must start the provider login flow first. The full purchase panel should only
open from these entries after the provider has an authenticated, not-subscribed
purchase token.
