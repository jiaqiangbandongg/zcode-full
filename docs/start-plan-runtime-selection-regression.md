# Start Plan Runtime Selection Regression

## Problem

When a provider family exposes both an active personal Coding Plan and an active
Start Plan, the settings UI persists the user's explicit connection choice in
`modelProviderFamilySelectedKeys`. The runtime provider registry must project
that same choice. A model label alone is not sufficient because both
connections can expose `GLM-5.3-Flash` while requiring different provider ids
and credentials.

The broken sequence was:

```text
User selects Start Plan
        |
        v
settings selectedKey = coding-plan:<start-plan-provider>
        |
        +--------------------> UI/session reconciliation targets Start Plan
        |
        `--------------------> registry resolver prefers Coding Plan by API key
                                      |
                                      v
                            switchModelConfig provider.notInRegistry
                                      |
                                      v
                              first send is rejected
```

## Required behavior

- In OAuth mode, a valid personal selected key is authoritative:
  - `coding-plan:builtin:zai-start-plan` selects `builtin:zai-start-plan`.
  - `coding-plan:builtin:zai-coding-plan` selects `builtin:zai-coding-plan`.
  - `coding-plan:builtin:bigmodel-start-plan` selects
    `builtin:bigmodel-start-plan`.
  - `coding-plan:builtin:bigmodel-coding-plan` selects
    `builtin:bigmodel-coding-plan`.
- Team Plan keys continue to force the family Coding Plan provider because the
  team project credential is projected through that provider id.
- If the selected personal provider is unavailable, registry resolution may use
  the existing availability fallback order; it must not project an unavailable
  provider merely because the selected key is stale.
- API Key mode remains isolated from OAuth connection keys and continues to
  select the family API Key provider.
- A send rejected before runtime admission must surface a visible, dismissible
  error above the composer while preserving the draft.

## Regression coverage

- Service tests cover explicit Start Plan selection while the sibling Coding
  Plan is also enabled and has an API key, for both Z.ai and BigModel.
- UI tests cover a `provider.notInRegistry` send failure becoming a visible
  runtime-model-unavailable composer error.
