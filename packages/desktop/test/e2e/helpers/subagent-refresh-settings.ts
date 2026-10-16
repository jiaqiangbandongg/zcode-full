import { subagentUpdateCursor } from "./subagent-snapshot-wait.js";
import { basename, join } from "node:path";
import { stat } from "node:fs/promises";
import { Key } from "webdriverio";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  TID_TASK_SETTINGS_BUTTON,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import {
  clickTestIdByDom,
  waitForTestIdByDom,
  readAgentsState,
  getE2EAppDataPaths,
} from "./desktop-app.js";
import { sel } from "./selectors.js";

export interface RefreshProfile {
  name: string;
  description: string;
  prompt: string;
  provider: string;
  model: string;
  effort: string;
  tools: string[];
}
const FORM = `form:has(input[type="text"]):has(${sel(TID_CHAT_MODEL_SELECT_TRIGGER)})`;
async function replaceProfileInput(input: WebdriverIO.Element, value: string) {
  if ((await input.getValue()) !== value) {
    // WebDriver clear 可能被受控字段重渲染还原；用真实全选输入替换，避免旧值拼接。
    await input.click();
    await browser.keys([process.platform === "darwin" ? Key.Command : Key.Control, "a"]);
    // elementSendKeys 可能重新定位光标并丢掉全选，继续向当前焦点发键才能替换原值。
    await browser.keys(value);
  }
  expect(await input.getValue()).toBe(value);
}
async function openSettings(workspacePath?: string) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "subagents"));
  const scope = $('[data-plugin-scope-trigger="true"]');
  await scope.waitForDisplayed({ timeout: 15000 });
  if ((await scope.getAttribute("data-plugin-scope-key")) !== (workspacePath ?? "user")) {
    await scope.click();
    await $(`[role="menuitemradio"]=${workspacePath ? basename(workspacePath) : "User"}`).click();
    await browser.waitUntil(
      async () => (await scope.getAttribute("data-plugin-scope-key")) === (workspacePath ?? "user"),
      { timeout: 15000 },
    );
  }
}
export async function saveRefreshProfile(
  profile: RefreshProfile,
  previousName?: string,
  options: { expectedError?: string; workspacePath?: string } = {},
) {
  const { expectedError } = options;
  await openSettings(options.workspacePath);
  if (previousName) await clickTestIdByDom(testId(TID_SUBAGENT_ROW, previousName));
  else {
    const create = $('button[aria-label="New"]');
    try {
      await create.waitForClickable({ timeout: 15000 });
    } catch (error) {
      const buttons = await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="New"]')).map(
          (button) => {
            const rect = button.getBoundingClientRect();
            return {
              disabled: button.disabled,
              html: button.outerHTML,
              rect: rect.toJSON(),
              overlapping: document
                .elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                .slice(0, 3)
                .map((e) => e.outerHTML.slice(0, 250)),
            };
          },
        ),
      );
      throw new Error(`Subagent New 不可点击: ${JSON.stringify(buttons)}`, { cause: error });
    }
    await create.click();
  }
  await $(FORM).waitForDisplayed({ timeout: 15000 });
  const inputs = await $(FORM).$$('input[type="text"]');
  for (const [input, value] of [
    [inputs[0]!, profile.name],
    [inputs[1]!, profile.description],
    [await $(FORM).$("textarea"), profile.prompt],
  ] as const)
    await replaceProfileInput(await input.getElement(), value);
  await $(FORM).$(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).click();
  await selectProfileModel(profile);
  await $(FORM).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).click();
  await clickTestIdByDom(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, profile.effort));
  await selectTools(profile.tools);
  if (expectedError) {
    await $(FORM).$('button[type="submit"]').click();
    await browser.waitUntil(async () => (await $("body").getText()).includes(expectedError), {
      timeout: 15000,
    });
    expect(await $(FORM).isExisting()).toBe(true);
    await $(FORM).$("button=Cancel").click();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  } else await submitProfile(profile.name, previousName, options.workspacePath);
}

/** 单字段用例只操作对应控件，不能重新选择模型掩盖局部保存的问题。 */
export async function updateRefreshProfileField(
  profile: RefreshProfile,
  field: "effort" | "prompt" | "tools",
) {
  await openSettings();
  await clickTestIdByDom(testId(TID_SUBAGENT_ROW, profile.name));
  await $(FORM).waitForDisplayed({ timeout: 15000 });
  if (field === "prompt")
    await replaceProfileInput(await $(FORM).$("textarea").getElement(), profile.prompt);
  if (field === "effort") {
    await $(FORM).$(sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).click();
    await clickTestIdByDom(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, profile.effort));
  }
  if (field === "tools") await selectTools(profile.tools);
  await submitProfile(profile.name);
}

async function selectTools(tools: string[]) {
  // 工具约束必须经真实表单保存，不能直接改文件再冒充动态 Settings 刷新。
  if (!(await $(FORM).$('[role="checkbox"]').isExisting())) {
    const triggers = await $(FORM).$$('[role="combobox"]');
    for (const trigger of triggers) {
      if ((await trigger.getText()).includes("Default all permissions")) {
        await trigger.click();
        break;
      }
    }
    const custom = $('[role="option"]=Custom allowed tools');
    await custom.waitForDisplayed({ timeout: 15000 });
    await custom.click();
  }
  const checkboxes = await $(FORM).$$('[role="checkbox"]');
  for (const checkbox of checkboxes) {
    const name = (await checkbox.getText()).trim();
    if (((await checkbox.getAttribute("aria-checked")) === "true") !== tools.includes(name))
      await checkbox.click();
  }
}

async function selectProfileModel(profile: Pick<RefreshProfile, "provider" | "model">) {
  const item = testId(
    TID_CHAT_MODEL_SELECT_ITEM,
    encodeCustomModelValue(profile.provider, profile.model),
  );
  const group = testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${profile.provider}`);
  await browser.waitUntil(
    async () => (await $(sel(item)).isExisting()) || (await $(sel(group)).isExisting()),
    { timeout: 15000 },
  );
  if (!(await $(sel(item)).isExisting())) await clickTestIdByDom(group);
  await clickTestIdByDom(item);
}

async function submitProfile(name: string, previousName?: string, workspacePath?: string) {
  const root = workspacePath
    ? join(workspacePath, ".zcode", "agents")
    : join(getE2EAppDataPaths().storageRoot, "agents");
  const exists = await stat(root).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const updated = await subagentUpdateCursor();
  await $(FORM).$('button[type="submit"]').click();
  await browser.waitUntil(async () => !(await $(FORM).isExisting()), {
    timeout: 15000,
    timeoutMsg: "Subagent 保存未完成",
  });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, name));
  if (previousName && previousName !== name)
    expect(await $(sel(testId(TID_SUBAGENT_ROW, previousName))).isExisting()).toBe(false);
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  // 首次创建目录的补扫日志记录范围；普通增量更新仍精确等待目标文件。
  await updated(undefined, [exists ? `${name}.md` : root]);
}
export async function setRefreshProfileEnabled(name: string, enabled: boolean) {
  await openSettings();
  const toggle = $(sel(testId(TID_SUBAGENT_ROW, name))).$('[role="switch"]');
  await toggle.waitForClickable({ timeout: 15000 });
  expect(await toggle.getAttribute("aria-checked")).toBe(String(!enabled));
  const updated = await subagentUpdateCursor();
  await toggle.click();
  // enabled 投影在 await service 保存后刷新；UI 恢复可操作构成保存完成屏障。
  await browser.waitUntil(
    async () =>
      (await toggle.getAttribute("aria-checked")) === String(enabled) && (await toggle.isEnabled()),
    { timeout: 15000 },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await updated();
}
export async function deleteRefreshProfile(name: string) {
  await openSettings();
  await $(sel(testId(TID_SUBAGENT_ROW, name)))
    .$('button[title="Delete"]')
    .click();
  const updated = await subagentUpdateCursor();
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
  await browser.waitUntil(
    async () => !(await $(sel(testId(TID_SUBAGENT_ROW, name))).isExisting()),
    { timeout: 15000 },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await updated();
}

/** 内置与插件共用真实行内控件；读磁盘确认即改即存完成，不直接写覆盖文件。 */
export async function setRefreshModelOverride(
  name: string,
  stateId: string,
  profile?: Pick<RefreshProfile, "provider" | "model" | "effort">,
) {
  await openSettings();
  const row = $(sel(testId(TID_SUBAGENT_ROW, name)));
  const trigger = row.$(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 15000 });
  const updated = await subagentUpdateCursor();
  await trigger.click();
  if (profile) {
    await selectProfileModel(profile);
    await browser.waitUntil(
      async () =>
        (await row
          .$(sel(testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, name)))
          .getAttribute("data-model-current-value")) ===
          encodeCustomModelValue(profile.provider, profile.model) && (await trigger.isEnabled()),
      { timeout: 15000 },
    );
    // 插件 overview 的异步刷新会重建行并关闭菜单；重新定位控件，等实际选项出现再选择。
    await browser.waitUntil(
      async () => {
        const item = $(sel(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, profile.effort)));
        if (await item.isExisting()) return true;
        const thought = $(sel(testId(TID_SUBAGENT_ROW, name))).$(
          sel(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER),
        );
        if (
          (await thought.isClickable()) &&
          (await thought.getAttribute("aria-expanded")) !== "true"
        ) {
          await thought.click();
        }
        return item.isExisting();
      },
      { timeout: 15000, timeoutMsg: `Subagent ${name} 思考等级菜单未就绪` },
    );
    await clickTestIdByDom(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, profile.effort));
  } else await $('[data-model-footer-action="subagent-model:built-in-default"]').click();
  await browser.waitUntil(
    async () => {
      const state = await readAgentsState();
      const overrides = (
        stateId.startsWith("plugin:")
          ? state.pluginAgentModelSelectionOverrides
          : state.builtInModelSelectionOverrides
      ) as Record<string, { modelId: string; options?: { reasoningLevel?: string } }> | undefined;
      const value = overrides?.[stateId];
      return profile
        ? value?.modelId === profile.model && value.options?.reasoningLevel === profile.effort
        : value === undefined;
    },
    { timeout: 15000 },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await updated();
}
