# Z.ai / BigModel Provider Family Merge

> 历史方案及 staging 行为来源，不是当前 Provider 数据结构契约。2026-09-06 恢复审计：
> 当前使用 `providerFamilyDomain` / `providerFamilyConnectionSelections`；账号 Provider 已拆成
> Start、Individual、Team，普通 API 通过 Template 创建。下文旧 `builtin:*`、mode/selectedKey、
> Provider Key 缓存及自动改会话选择的段落不可作为恢复旧架构的依据。
> 本轮保留的产品行为是 Family 连接菜单、独立查询 Start 权益和数量快捷入口。
> 具体适配与未决行为见 [Todo 85 审计表](working-memory/provider-refactor/plan/staging-conflict-restoration-audit.md)。

## Goal

Z.ai and BigModel currently expose six built-in model provider ids:

```txt
builtin:zai
builtin:zai-start-plan
builtin:zai-coding-plan
builtin:bigmodel
builtin:bigmodel-start-plan
builtin:bigmodel-coding-plan
```

The product experience should merge them into two user-facing provider families:

```txt
Z.ai
BigModel
```

The six provider ids must remain the runtime and persistence identities. They are
used by saved provider configs, historical task model refs, provider registry
sync, model selection values, OAuth-derived credentials, quota checks, logs, and
agent runtime routing. This change only merges the user-facing provider
selection model.

## Provider Family Mapping

```txt
Z.ai
├─ API Key     -> builtin:zai
├─ Start Plan  -> builtin:zai-start-plan
└─ Coding Plan -> builtin:zai-coding-plan

BigModel
├─ API Key     -> builtin:bigmodel
├─ Start Plan  -> builtin:bigmodel-start-plan
└─ Coding Plan -> builtin:bigmodel-coding-plan
```

Each family has one visible identity and one resolved internal provider target.
The internal target is selected from the existing provider ids by connection
mode, OAuth login state, and entitlement state.

## Settings Navigation And Connection Menu

The Model Providers side navigation is a provider-family selector only. Built-in
families are shown as one entry per family, for example `Z.ai` and `BigModel`.
The side navigation must not render `Start Plan`, personal `Individual Plan`,
team `Team Plan`, or `API Key` as separate sibling entries.

Connection switching lives inside the selected family detail page. That menu is
the only place where connection modes are listed:

- Logged out: show personal `Individual Plan` and `API Key`; a stale saved
  `Start Plan` selection falls back to the disconnected `Individual Plan`
  detail instead of leaving the family detail in a permanent loading state.
- Logged in: show `Start Plan` whenever the account has active Start
  entitlement, including when personal or team Coding entitlement is also
  active. Start and Coding are independent choices rather than mutually
  exclusive priority branches.
- Logged in: always show personal `Individual Plan`.
- Logged in: show one `Team Plan` entry per fetched team plan.
- Always show `API Key`.

Connection labels are localized as `Individual Plan` / `个人套餐` for the
personal Coding Plan provider and `Team Plan` / `团队套餐` for team entries.

The family detail page must not render a concrete connection page before the
family connection settings have finished the first read. While that read is
pending, the detail area stays in its loading state instead of guessing `Start
Plan`, personal `Coding Plan`, or `API Key`.

If the first connection settings read fails and there is no usable settings
snapshot, the detail page falls back to the family `API Key` provider. This is a
degraded UI state, not a persisted user choice: the connection menu label shows
an info icon and the localized `connection settings failed` warning text using
the warning text color, while the select value itself shows `API Key`.

Team Plan connection labels should not fall back to the generic `Team` label
when the app can still read a subscription entitlement snapshot. If enterprise
pricing is unavailable but subscription data proves a Team Plan exists, the
fallback item should use the entitlement-derived plan label before falling back
to `Team`.

Team Plan availability messages are conclusive states. While its provider key,
entitlement, or project assignment is loading, the detail page shows the checking
state and must not display the `Team Plan is not assigned` administrator message.
That message appears only after loading finishes and the project is still
explicitly unavailable.

Connection transitions preserve a resolved personal entitlement snapshot while
provider key and entitlement refresh continue in the background. A cached
`purchased` or confirmed `notPurchased` detail remains visible with its loading
indicator; the full `checking` placeholder is reserved for transitions that have
no resolved entitlement snapshot. This prevents the detail from flashing from
cached data to `checking` and back.

Selecting a Team Plan from the Coding Plan upgrade page requires provider OAuth
before entering team configuration. If the user is logged out, the selected Team
Plan key remains pending while OAuth runs. After a successful callback, the app
refreshes the purchase token and authenticated enterprise pricing, then resumes
that Team Plan selection exactly once. Pending personal/team selection is bound
to the concrete login request id that it started. Login cancellation, failure,
or replacement by another login request clears that pending selection; a later
unrelated login must not advance the old purchase intent.

Personal Coding Plan selection follows the same authentication boundary. The
selected personal plan key remains pending during OAuth and resumes once into
the billing-cycle selection step only after the authenticated product preview is
ready. Team and personal pending selections are isolated and cannot resume each
other's purchase path. A later OAuth expiry during payment confirmation may keep
the concrete product pending and resume that narrower payment action separately,
but that payment action is bound to the concrete login request id under the same
cancel/failure/replacement rules. Provider-specific requests complete only from
a matching Provider OAuth success signal; a pre-existing global app user must not
complete a newly started Provider login attempt.

OAuth login completion updates the connection selection in the Root callback
after the available connection modes are resolved, using this priority:
purchased `Individual Plan`, first purchased `Team Plan`, purchased
`Start Plan`, then the `Individual Plan` entry as the no-entitlement
fallback. The selected side navigation key remains the provider family key; the
concrete connection mode is stored separately in `modelProviderFamilyModes` and
the specific connection entry is stored in `modelProviderFamilySelectedKeys`.
API Key login is a separate explicit path: it writes
`modelProviderFamilyModes[family] = "apiKey"` and does not participate in the
OAuth entitlement priority.

Purchase credential hydration distinguishes active loading from a failed read.
Only unresolved/in-flight reads block plan actions. A failed read shows a
recoverable error with an explicit retry action and must not leave personal or
team purchase controls in an indefinite loading state. The recovery action stays
visible even while products are loading, unavailable, or empty.

Normal entry into Model Provider settings restores a valid saved
`modelProviderFamilySelectedKeys[family]`. The settings page must not run its
own entitlement-priority initialization or overwrite the saved selected key on
mount; login/re-login freshness is handled by the Root callback writing shared
settings.

User-initiated connection switching must treat `modelProviderFamilyModes` and
`modelProviderFamilySelectedKeys` as one UI state. While the settings write is
in flight, both values need local pending state and the detail page must read the
combined effective values. Initialization priority is only a fallback for missing
selection data outside the settings page; it must not override the connection
item that the user just picked.

The family header also exposes the current family's Start Plan subscription count
when the selected connection is not Start Plan. The count comes only from the
existing Start Plan entitlement snapshot's `subscription.details.length`; it must
not trigger another request. A positive count renders a compact `Start Plan × N`
action immediately to the left of the connection selector. Clicking it must reuse
the same user-owned connection transition as selecting Start Plan from the selector.
The action stays hidden when the count is zero or unknown, the entitlement read has
failed, the family has no Start Plan navigation item, or Start Plan is already
selected. Z.ai and BigModel resolve their own Start Plan provider independently.
The shortcut stays in the connection-mode control. It and the visible
`Connection mode` label are mutually exclusive: when the shortcut is available,
it replaces that label immediately before the always-visible selector; otherwise
the normal label remains. Its leading tickets icon and colors reuse the existing
`150% Quota` campaign badge palette, including the established dark-theme
fallback. When visible, an external `Switch to` (`切换至`) prefix replaces the
normal `Connection mode` label, followed by the unchanged `Start Plan × N`
(`体验套餐 × N`) button. The control does not render a Tooltip.

```text
Start entitlement snapshot for selected family
  |-- details.length <= 0 / unavailable ----------------------> no shortcut
  `-- details.length = N > 0
        |-- selected connection is Start Plan ----------------> no shortcut
        `-- selected connection is API/Individual/Team
              -> Switch to [tickets Start Plan × N] [current ▼]
                    `-- click -> existing family selection transition -> Start Plan
```

The user action owns the connection transition. Switching to a Plan connection
persists the mode and selected key, then performs at most one provider-key and
entitlement refresh for the selected provider. Temporary presentation states such
as `checking`, `disconnected`, or `purchased` must not start or identify another
transition. When settings opens with an already active OAuth account but a provider
key that has not hydrated yet, background reconciliation uses the stable tuple
`providerId + activeOAuthProvider` and runs at most once per mounted settings page.
This rule applies equally to Z.ai and BigModel.

### Connectivity Check Credential Boundary

The Model Provider settings connectivity check must use the effective credential
of the currently selected family connection. For a selected Team Plan, the host
service resolves the provider credential from the current provider registry
snapshot, which is scoped by `modelProviderFamilySelectedKeys[family]`, instead
of using the personal Coding Plan key persisted on the provider config.

If the selected Team Plan cannot produce a runtime provider credential, the
connectivity check fails closed and must not fall back to a personal Coding Plan
key belonging to a different entitlement subject. The selected model, endpoint,
API format, request body, and existing connectivity error mapping remain
unchanged. This rule applies equally to Z.ai and BigModel.

## Provider Family Domain Boundary

Z.ai and BigModel are mutually exclusive provider family runtime domains. The
active runtime domain is stored in `AppSettings.providerFamilyDomain`, not
derived directly from `oauth:active_provider`.

```txt
No providerFamilyDomain
├─ WelcomeScreen shows Z.ai and BigModel
└─ The user can connect either provider with OAuth or API Key

providerFamilyDomain = zai
├─ Settings shows Z.ai
├─ Settings hides BigModel
└─ The model menu hides BigModel built-in models

providerFamilyDomain = bigmodel
├─ Settings shows BigModel
├─ Settings hides Z.ai
└─ The model menu hides Z.ai built-in models
```

This boundary applies to the full built-in family, not only the OAuth
sub-provider. When Z.ai is the selected provider family domain, BigModel API
Key, Start Plan, and Coding Plan entries are not shown as built-in choices.
Custom providers are not affected.

`oauth:active_provider` remains the OAuth authentication fact and a legacy
migration source. It no longer directly decides which built-in family is visible
or included in the runtime provider registry.

An existing task or draft may still carry the provider runtime that was selected
before a connection-mode change. Before a session is created or resumed for the
next prompt, the app must project that stale runtime model onto the provider
selected by the current family connection facts. `apiKey` selects the family's built-in API Key provider;
`oauth` selects the provider encoded by the family's selected plan key. The model
name is preserved when the target provider exposes it, otherwise the target
provider's first available model is used. This reconciliation applies to both
Z.ai and BigModel and is required in both transition directions; a task must not
reuse an expired plan runtime after switching to API Key, or an invalid API Key
runtime after switching to an available plan. Renderer-local queued prompts
resolve these connection facts again when the queue drains, because the user may
switch connections while the preceding turn is still running.

## Resolution Rules

The UI keeps a connection mode per family:

```ts
type ProviderFamilyId = "zai" | "bigmodel";
type ProviderFamilyConnectionMode = "oauth" | "apiKey";
```

The mode is persisted as an app-level UI preference in
`AppSettings.modelProviderFamilyModes`, stored in `~/.zcode/v2/setting.json`:

```json
{
  "modelProviderFamilyModes": {
    "zai": "oauth",
    "bigmodel": "apiKey"
  }
}
```

The selected runtime domain is persisted separately:

```json
{
  "providerFamilyDomain": "zai",
  "providerFamilyDomainUpdatedAt": 1780984123000,
  "providerFamilyDomainMigrated": true
}
```

`providerFamilyDomain` is written only after a WelcomeScreen OAuth or API Key
connection succeeds. Logout, unlink, or removing the last usable credential in
the selected domain clears it and updates `providerFamilyDomainUpdatedAt`.

This field is intentionally not part of `ModelProviderConfig` and does not
create new provider ids. The existing six provider ids remain the only
credential, save, test, registry, and runtime targets. Missing family mode
values default to `oauth` to preserve the existing Start/Coding-first behavior.

The selected family resolves to one internal provider target:

```txt
API Key mode
└─ Use the family API Key provider id

OAuth mode
├─ Not signed in to the family OAuth provider
│  └─ Show sign-in
├─ Saved selected connection is still available
│  └─ Preserve its concrete Start / personal Coding / Team provider target
├─ Saved Start connection is conclusively inactive
│  └─ Use the family Coding Plan provider id
└─ No saved connection can be restored
   └─ Resolve the existing login/default priority and persist the result
```

Start entitlement discovery runs independently from Coding entitlement
discovery. A Coding subscription must not suppress the Start query or remove an
active Start connection. When Start is conclusively inactive, fallback remains
the personal Coding Plan entry so the user sees the subscribed, unavailable, or
purchase state instead of a stale free-plan detail.

When the user switches a family to API Key mode or saves a non-empty API Key
for the family API Key provider, the settings page treats that action as an
explicit request to use the API Key provider. If the provider still carries a
local `enabled: false` value from an older manual disable or stale snapshot, the
settings save must restore it to `enabled: true` and clear
`systemDisabledReason`. This recovery applies only to the family API Key
provider (`builtin:zai` or `builtin:bigmodel`) and must not re-enable Start Plan
or Coding Plan providers that are disabled by entitlement state.

When the selected family connection mode is API Key and the API Key provider is
not active because its key is empty, the detail page shows an inline banner near
the provider form: setting an API Key will enable the provider. This banner is
limited to the family API Key provider and should not appear for Coding Plan,
Start Plan, Team Plan, or for a provider that already has a key but was manually
disabled.

## Settings Page UI

The preset provider navigation shows provider families only:

```txt
Preset Providers
├─ Z.ai
└─ BigModel
```

It must not show these as separate nav items:

```txt
Z.ai - API Key
Z.ai - Coding Plan
Z.ai - Coding Plan
BigModel - API Key
BigModel- Coding Plan
BigModel - Coding Plan
```

Selecting `Z.ai` or `BigModel` opens one family detail page. The detail content
uses a fixed structure:

```txt
<provider icon> Z.ai / BigModel        <status>        <enabled switch>

<Plan Card>

<URL / Format / API Key>               // API Key mode only

<Models>
```

The mode control lives in the Plan Card, not in the page header. It is a
two-state switch:

```txt
Switch on  -> Coding Plan mode
Switch off -> API Key mode
```

The switch writes only `AppSettings.modelProviderFamilyModes`. Turning the
switch on selects the currently resolved Start/Coding provider nav item for the
family. Turning it off selects the family API Key provider nav item.

## Plan Card

The Plan Card is always visible. It summarizes the current account plan and
also owns the Coding Plan/API Key switch:

```txt
┌────────────────────────────────────────────────────────────────┐
│  Plan Name                              Coding Plan  [ switch ] │
│  no entitlement / renew / expire · Manage · Upgrade            │
└────────────────────────────────────────────────────────────────┘
```

Plan name rules:

- With entitlement: show the real plan name.
- Without entitlement: fall back to `Coding Plan`.

The second line is one row. Status text and actions are inline:

```txt
no entitlement / renew / expire · Manage · Upgrade
```

When the switch is on, API connection fields are hidden:

```txt
┌────────────────────────────────────────────────────────────────┐
│  Coding Pro                           Coding Plan  [ on  ]     │
│  Renews Jun 30, 2026 · Manage · Upgrade                        │
│────────────────────────────────────────────────────────────────│
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │  5h usage      │  │  1w usage      │  │  Total tokens   │    │
│  │  12.4k / 50k   │  │  83k / 500k    │  │  1.28M          │    │
│  └────────────────┘  └────────────────┘  └────────────────┘    │
└────────────────────────────────────────────────────────────────┘

<Models>
```

Coding Plan mode renders the resolved state:

- Not signed in: sign-in card for the selected family.
- Coding entitlement: show the Plan Card summary, then a divider and three
  usage cards: `5h usage`, `1w usage`, `Total tokens`.
- Start entitlement only: show the Plan Card summary, then a divider and three
  daily usage cards.
- No Coding and no Start entitlement: show only the Plan Card summary; do not
  render the divider or usage cards.

When the switch is off, the Plan Card remains visible, usage cards are hidden,
and the existing API Key provider form is shown below it:

```txt
┌────────────────────────────────────────────────────────────────┐
│  Coding Plan                          Coding Plan  [ off ]     │
│  No entitlement · Manage · Upgrade                            │
└────────────────────────────────────────────────────────────────┘

<URL / Format / API Key>

<Models>
```

The detailed provider form may reuse the existing provider card components, but
the visible product identity should be family-first:

```txt
Provider: Z.ai
Mode: Coding Plan
```

instead of:

```txt
Z.ai - Coding Plan
```

Provider ids may remain visible only in advanced/debug affordances.

## Model Menu UI

The chat input model menu should not present the active built-in family as a
nested provider group. The active built-in family models are flat first-level
choices and keep their model names unchanged:

```txt
GLM-5.1
GLM-5-Turbo
model3 name
Custom Provider >
```

or:

```txt
GLM-5.1
GLM-5-Turbo
model3 name
Custom Provider >
```

The displayed label is only the model name, while the option value keeps the
true provider id:

```txt
label: GLM-5.1
value: builtin:zai-coding-plan/GLM-5.1
```

```txt
label: GLM-5.1
value: builtin:bigmodel-start-plan/GLM-5.1
```

The model menu must apply the selected family mode first, then the OAuth
identity boundary:

```txt
Family mode = API Key
└─ Show the family API Key provider models only

Family mode = OAuth
└─ Show the resolved Start/Coding provider models only
```

When an active OAuth provider is known, the menu must also apply the OAuth
identity boundary:

```txt
Active OAuth provider = zai
├─ Show Z.ai family models according to its selected family mode
├─ Hide builtin:bigmodel
├─ Hide builtin:bigmodel-start-plan
└─ Hide builtin:bigmodel-coding-plan

Active OAuth provider = bigmodel
├─ Show BigModel family models according to its selected family mode
├─ Hide builtin:zai
├─ Hide builtin:zai-start-plan
└─ Hide builtin:zai-coding-plan
```

If a family resolves to Coding Plan with no entitlement, its model options may
be shown disabled with a no-entitlement reason. They should not silently switch
to Start Plan.

Custom providers keep their existing grouped or submenu behavior.
Only Z.ai and BigModel built-in family models are flattened into first-level
menu choices.

## Runtime Registry

The provider registry sent to the agent continues to use existing provider ids.
The registry should include at most one active built-in provider per visible
family:

```txt
Z.ai family
└─ one of builtin:zai, builtin:zai-start-plan, builtin:zai-coding-plan

BigModel family
└─ one of builtin:bigmodel, builtin:bigmodel-start-plan, builtin:bigmodel-coding-plan
```

This avoids duplicate same-name models after display merging. It also keeps the
agent runtime simple: model refs still identify the exact provider id needed for
endpoint selection, API key source, scoped runtime headers, and entitlement
gating.

When the selected family mode changes, the next provider registry sync should
replace the resolved provider target. If the current selected model uses the old
target, the UI should try to preserve the same model id on the new resolved
target, then fall back to the first available model.

## Compatibility

No provider storage migration is required.

- Existing `model-providers.json` records keep their ids.
- Existing task model refs keep resolving by old provider id.
- `refreshCodingPlanApiKey(providerId)` still accepts Start/Coding provider ids.
- OAuth-derived keys remain isolated by the existing provider id.
- Remote workspace provider registry sync keeps using the same provider ids.
- Mobile remote control should only observe the synced model catalog result; it
  must not create a separate provider resolution path.

## Implementation Notes

### Empty Coding Plan model list

Coding Plan authentication and entitlement do not depend on the number of configured models.
After the user deletes every model, Settings must keep the purchased plan details visible and
continue to render the empty model section with the Add Model action. The chat model menu has no
options for that provider until a model is added again. An empty model list must not turn a valid
Coding Plan connection into a disconnected state. The empty-model message is presented in a
transparent, `rounded-lg` container with a dashed semantic border and a fixed `h-12` height. The icon-label pair is vertically centered and left-aligned, and the Add Model action remains below it.
The message includes a leading `Info` icon and keeps the icon-label pair left-aligned.

The Add Model Provider form ends with a footer separated by a semantic top border. A `text-ui-base` `Info` hint
on the left reminds the user that at least one model is required, while the Add Provider action stays on the right. On narrow mobile layouts, the footer stacks without clipping the localized
copy.

Recommended implementation pieces:

1. Add a family spec and pure resolver for provider family view state.
2. Change settings preset navigation to emit `providerFamily` items for Z.ai and
   BigModel.
3. Change settings detail to render a family detail page with OAuth/API Key mode.
4. Extend Start/Coding availability validation so BigModel uses the same paired
   decision boundary as Z.ai.
5. Filter runtime registry projection to one resolved built-in provider per
   visible family.
6. Change chat input model menu so active family models are flat first-level
   entries whose visible label is the model name only.

## Validation

### Provider 二级模型菜单宽度

- 默认最小宽度为 192px，宽度跟随最长模型名称、Vision 标签及选中标记所需空间增长，不使用固定宽度提前截断。
- 最大宽度受 Radix 当前方向可用空间约束；空间不足时允许低于最小宽度，名称省略，标签与选中标记保留。
- 手机远控已有的窄屏样式覆盖继续生效。验证桌面深浅主题、长短名称、窗口边缘，以及手机样式覆盖下的选择行为。
- 浏览器回归：`node --test packages/ui/test/browser/manual-review/pending/model-submenu-width.test.mjs`（真实组件，非完整远控链路）。

### 窄屏连接方式布局

- Family 标题、状态与右侧操作区优先保持同一行；操作区以紧凑基础宽度参与 Flex 换行计算，并允许团队名称收缩，不能先按全称宽度把整组操作挤到下一行。只有标题和操作区基本宽度也放不下时才整体换行。
- 连接方式操作区按控件实际宽度自然换行，不设置固定断点强制拆行，也不使用 `w-full` 拉满选择框；移除独立的「Switch to / 切换至」文字，Start Plan 快捷按钮使用 `ControlHintTooltip`，悬停或键盘聚焦时显示「切换至体验套餐」（英文 “Switch to Start Plan”），提示不带数量；按钮继续保留可访问名称与点击切换行为。
- 能容纳快捷入口和选择框时保持同行；选择框优先完整展示名称，不设固定最大宽度；先保留快捷入口与箭头所需空间，名称使用当前行剩余空间，仅在全称确实放不下时省略。短名称不拉伸成空白长框；剩余空间连控件基本宽度都不足时才换行。
- 展开菜单后团队全称允许换行（包括无空格英文），菜单不得超出视口；选择与 Start Plan 快捷入口行为不变。
- 使用 Flex 自然换行，覆盖手机 Web、窄桌面面板、中英文及浅色/深色主题；不改变 provider、远控或消息流逻辑。
- 浏览器回归：`node --test packages/ui/test/browser/manual-review/pending/provider-family-responsive.test.mjs`。
  直接挂载真实 Family 组件、Radix Select、国际化与产品 CSS，验证 320/390/430 手机视口、650px 视口（可同行但之前被固定断点拆行）、宽视口中的窄面板与桌面横排，检查几何边界并实际选择连接项。
  此用例为待审核的组件浏览器交互回归，不代表完整 `/remote` 连接链路验证。

Automated validation must include:

- `pnpm typecheck`
- `pnpm lint`

Targeted test coverage:

- No OAuth session shows both provider families in settings.
- Z.ai OAuth session hides BigModel in settings and model menu.
- BigModel OAuth session hides Z.ai in settings and model menu.
- API Key mode resolves to the existing API Key provider id.
- OAuth + Coding entitlement resolves to the existing Coding Plan provider id.
- OAuth + no Coding + Start entitlement resolves to the existing Start Plan
  provider id.
- OAuth + no Coding + no Start shows Coding Plan as no entitlement.
- Model menu labels are flat model names without provider prefixes.
- Model menu option values keep the old provider ids.
