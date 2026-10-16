# Settings skill list

Skill rows present scope as compact ownership metadata next to the skill name.

- The leading item icon reuses the `WandSparkles` icon from the Skills settings navigation.
- Workspace scope: folder icon + workspace basename, falling back to the localized project label.
- Plugin scope: plug icon + plugin display name. Canonical names such as `zcode-guide` are formatted with the same plugin-store rule as `Zcode Guide`, falling back to the localized plugin label when absent.
- User scope: user icon + localized Personal label.
- Scope icons render at 14px while retaining the shared Badge leading-icon padding.
- Scope uses the shared Badge with `bg-surface`, `border-border`, a pill-shaped `rounded-full` shape, and `text-ui-sm` text.
- The old standalone scope column and redundant plugin-managed badge are not rendered.
- Description remains below the name row. Enable and delete controls remain available only for non-plugin skills.
- Item descriptions use `text-ui-sm text-foreground-subtle` as secondary copy.
