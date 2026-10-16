# Settings list create actions

Settings resource lists use one consistent treatment for their page-level create action.

- Commands, Subagents, MCP, Hooks, Skills, and Plugins render the create action as a default `Button`. The Plugins action directly opens Add Marketplace Source because it has only one available creation action.
- The button uses `size="lg"` (`data-size="lg"` in the rendered DOM) and presents a leading plus icon followed by the compact label `New` / `新建`. The icon carries `data-icon="inline-start"`, activating the standard 8px leading and 10px trailing padding. Its accessible label retains the resource-specific action name.
- Commands, MCP, and Skills render their page-level import action as an outline `Button` with `size="lg"`, a leading Lucide `Import` icon, and the localized action label.
- The Commands, MCP, and Skills import buttons use the compact visible label `Import` / `导入`; their accessible labels keep the full external-agent import descriptions.
- The import action sits immediately to the left of the create action. Other utility actions such as folder, sync, and refresh remain before the import/create pair.
- Page-level icon-only utility actions in Settings list headers use `variant="outline"` and `size="icon-lg"`. Row actions and detail actions are outside this rule.
- The create action is the last control in the list header action group.
- The rule applies equally to desktop and mobile Web layouts because both render the same responsive settings sections.
- Automations are excluded: scheduled-task and off-peak creation use their own multi-action controls.
- Form submit buttons and nested additions such as adding a model or schedule are outside this rule.
- Contextual imports such as a Hooks list-row action and migration confirmation actions are outside this page-header rule.
