// M5 门禁：composer 工具条（模型选择器 / 思考深度 / 模式 / slash 候选面板）。
// 证据层 L3：
// 1) slash 面板——展示 CLI builtin 与 App Composer-only catalog（compact/goal/init/plan；无 resume-goal）、模糊过滤、选中插入命令 pill；
// 2) 模型选择器——切到另一注册模型 + 思考深度后，Composer Draft 立即更新；
// 3) 模式选择——ChatModeSwitchControl 立即更新同一 Composer Draft；
// 4) context usage——首轮 ModelComplete 后 usage.contextWindow 投影（data-usage-used>0）。
// 5) task → draft——已有模型目录时仍独立重新水合 slash 目录，自定义命令继续出现。
// 6) draft → 已知 task——同一 workspace 的 slash 目录不被 task 导航清空。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import { UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL } from "../helpers/upstream-provider.js";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared";
import {
  clickV4SlashOption,
  getV4ComposerText,
  getV4ConfigProjection,
  getV4ModelConfig,
  getV4PaneSnapshot,
  getV4SlashOptionIds,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  startNewV4Draft,
  switchV4Mode,
  switchV4Model,
  waitForV4Pane,
  waitForV4SlashOption,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CUSTOM_SLASH_COMMAND_NAME = "e2e-draft-catalog";
const CUSTOM_SLASH_OPTION_ID = `slash:${CUSTOM_SLASH_COMMAND_NAME}`;
const CUSTOM_SLASH_COMMAND_DIR = join(getE2EAppDataPaths().homeDir, ".zcode", "commands");
const CUSTOM_SLASH_COMMAND_PATH = join(CUSTOM_SLASH_COMMAND_DIR, `${CUSTOM_SLASH_COMMAND_NAME}.md`);
const COMPOSER_PICKER_TRIGGER_IDS = {
  mode: TID_CHAT_MODE_SELECT_TRIGGER,
  model: TID_CHAT_MODEL_SELECT_TRIGGER,
  thought: TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
} as const;

type ComposerPicker = keyof typeof COMPOSER_PICKER_TRIGGER_IDS;

async function openComposerPicker(picker: ComposerPicker) {
  const trigger = $(`[data-testid="${COMPOSER_PICKER_TRIGGER_IDS[picker]}"]`);
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
}

async function waitForOnlyComposerPickerOpen(picker: ComposerPicker, transition: string) {
  let latest: unknown = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (triggerIds) => {
          const expanded = Object.fromEntries(
            Object.entries(triggerIds).map(([key, testId]) => [
              key,
              document
                .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
                ?.getAttribute("aria-expanded") ?? null,
            ]),
          );
          return {
            expanded,
            listboxes: document.querySelectorAll('[role="listbox"]').length,
            menus: document.querySelectorAll('[role="menu"]').length,
          };
        },
        COMPOSER_PICKER_TRIGGER_IDS,
      );
      const state = latest as {
        expanded: Record<ComposerPicker, string | null>;
        listboxes: number;
        menus: number;
      };
      const expectedListboxes = picker === "model" ? 0 : 1;
      const expectedMenus = picker === "model" ? 1 : 0;
      return (
        state.expanded[picker] === "true" &&
        Object.entries(state.expanded).every(
          ([key, value]) => key === picker || value !== "true",
        ) &&
        state.listboxes === expectedListboxes &&
        state.menus === expectedMenus
      );
    },
    {
      timeout: 5000,
      timeoutMsg: `${transition} 后没有只保留目标 picker；latest=${JSON.stringify(latest)}`,
    },
  );
}

async function waitForNoComposerPickerOpen(transition: string) {
  let latest: unknown = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (triggerIds) => ({
          expanded: Object.fromEntries(
            Object.entries(triggerIds).map(([key, testId]) => [
              key,
              document
                .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
                ?.getAttribute("aria-expanded") ?? null,
            ]),
          ),
          listboxes: document.querySelectorAll('[role="listbox"]').length,
          menus: document.querySelectorAll('[role="menu"]').length,
        }),
        COMPOSER_PICKER_TRIGGER_IDS,
      );
      const state = latest as {
        expanded: Record<ComposerPicker, string | null>;
        listboxes: number;
        menus: number;
      };
      return (
        Object.values(state.expanded).every((value) => value !== "true") &&
        state.listboxes === 0 &&
        state.menus === 0
      );
    },
    {
      timeout: 5000,
      timeoutMsg: `${transition} 后 composer picker 没有全部关闭；latest=${JSON.stringify(latest)}`,
    },
  );
}

async function closeComposerPicker() {
  await browser.keys("Escape");
  await waitForNoComposerPickerOpen("Escape");
}

describe("v4 M5 门禁：composer 工具条与 slash 候选面板", () => {
  let completedTaskId: string | null = null;
  let customSlashHydratedInDraft = false;

  async function ensureCompletedTask() {
    if (completedTaskId) {
      return completedTaskId;
    }
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED 建立会话");
    await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态",
      45000,
    );
    completedTaskId = (await getV4PaneSnapshot()).sessionId;
    if (!completedTaskId || completedTaskId === "draft") {
      throw new Error("composer toolbar 首轮没有留下可重新打开的 completed task");
    }
    return completedTaskId;
  }

  async function ensureCustomSlashHydratedInDraft() {
    if (customSlashHydratedInDraft) {
      return;
    }
    await startNewV4Draft();
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      timeout: 15000,
      timeoutMsg: "task → draft 后 v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption(CUSTOM_SLASH_OPTION_ID);
    expect(await getV4SlashOptionIds()).toContain(CUSTOM_SLASH_OPTION_ID);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "task → draft slash 回归断言后没有清空 composer",
    });
    customSlashHydratedInDraft = true;
  }

  before(async () => {
    await mkdir(CUSTOM_SLASH_COMMAND_DIR, { recursive: true });
    await writeFile(
      CUSTOM_SLASH_COMMAND_PATH,
      [
        "---",
        "description: E2E task-to-draft slash catalog rehydration",
        "argument-hint: [scope]",
        "---",
        "",
        "Draft slash catalog fixture $ARGUMENTS.",
      ].join("\n"),
      "utf-8",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(CUSTOM_SLASH_COMMAND_PATH, { force: true });
    await clearAppData();
  });

  it("slash 面板：/ 触发目录候选，过滤后选中插入命令", async () => {
    await prepareV4ConversationE2E();

    // `/` 触发：CLI protocol catalog 的内建命令全部出现，UI 私有 alias 不出现。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:compact");
    await waitForV4SlashOption("slash:init");
    await waitForV4SlashOption("slash:plan");
    const optionIds = await getV4SlashOptionIds();
    expect(optionIds).toContain("slash:compact");
    expect(optionIds).toContain("slash:goal");
    expect(optionIds).toContain("slash:init");
    expect(optionIds).toContain("slash:plan");
    expect(optionIds).not.toContain("slash:resume-goal");

    // App-only `/plan` 仍按普通 slash catalog mention 插入，允许用户继续填写任务参数。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/plan", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:plan");
    expect(await clickV4SlashOption("slash:plan")).toBe(true);
    await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").startsWith("/plan"), {
      timeout: 15000,
      timeoutMsg: "选中 /plan 后命令没有插入 composer",
    });
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "选中 /plan 后没有清空 composer",
    });

    // 模糊过滤：/goa → goal 仍在候选中
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/goa", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:goal");

    // 选中：插入 `/goal ` 命令文本（mention pill 的 markdown），面板关闭
    expect(await clickV4SlashOption("slash:goal")).toBe(true);
    await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").startsWith("/goal"), {
      timeout: 15000,
      timeoutMsg: "选中 slash 候选后命令没有插入 composer",
    });
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 slash 候选后面板没有关闭",
    });

    // 清空草稿，避免影响后续用例
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
  });

  it("模型选择器/思考深度/模式切换 → config 投影更新；usage 投影非零", async () => {
    await ensureCompletedTask();

    // 带最新投影值的分段等待（超时报文里带上 config 现值，便于定位卡在哪一段）。
    const waitForModelConfig = async (
      predicate: (cfg: {
        provider: string | null;
        model: string | null;
        thought: string | null;
      }) => boolean,
      label: string,
    ) => {
      let latest: unknown = null;
      try {
        await browser.waitUntil(
          async () => {
            const cfg = await getV4ModelConfig();
            latest = cfg;
            return predicate(cfg);
          },
          { timeout: 30000, timeoutMsg: label },
        );
      } catch (error) {
        // 失败诊断：v4 命令 ack 环形缓冲（生产 renderer 日志关闭，这是唯一 probe 面）。
        const acks = await browser
          .execute(() =>
            JSON.stringify(
              (window as Window & { __zcodeV4CommandAcksE2E?: unknown[] })
                .__zcodeV4CommandAcksE2E ?? [],
            ),
          )
          .catch(() => "acks unavailable");
        throw new Error(`${label}; latest=${JSON.stringify(latest)}; acks=${acks}`, {
          cause: error,
        });
      }
    };

    // 模型选择器：切到已注册的第二个模型 + thought=max
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    await waitForModelConfig(
      (cfg) => cfg.model === UPSTREAM_SECONDARY_MODEL,
      "模型选择器切换后 config.model 投影没有更新",
    );
    await waitForModelConfig(
      (cfg) => cfg.thought === "max",
      "思考深度切换后 config.thought 投影没有更新",
    );
    const cfg = await getV4ModelConfig();
    expect(cfg.provider).toBe(UPSTREAM_PROVIDER_ID);

    // 模式选择：build → plan（只观察 Composer 当前状态）
    await switchV4Mode("plan");
    let latestMode: string | null = null;
    try {
      await browser.waitUntil(
        async () => {
          latestMode = (await getV4ModelConfig()).mode;
          return latestMode === "plan";
        },
        { timeout: 30000, timeoutMsg: "模式切换后 config.mode 投影没有更新为 plan" },
      );
    } catch (error) {
      throw new Error(`模式切换后 config.mode 投影没有更新为 plan; latest=${latestMode}`, {
        cause: error,
      });
    }

    // context usage：首轮 ModelComplete 后 usage.contextWindow 投影非零
    const projection = await getV4ConfigProjection();
    expect(projection.usageUsed).toBeGreaterThan(0);
  });

  it("模式/模型/思考深度 picker 互斥，后打开者保持唯一可见", async () => {
    await ensureCompletedTask();

    await openComposerPicker("mode");
    await waitForOnlyComposerPickerOpen("mode", "打开模式 picker");
    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "Select→Dropdown");
    await closeComposerPicker();

    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "打开模型 picker");
    await openComposerPicker("thought");
    await waitForOnlyComposerPickerOpen("thought", "Dropdown→Select");
    await closeComposerPicker();

    await openComposerPicker("mode");
    await waitForOnlyComposerPickerOpen("mode", "重新打开模式 picker");
    await openComposerPicker("thought");
    await waitForOnlyComposerPickerOpen("thought", "Select→Select");
    await closeComposerPicker();
  });

  it("completed task 的 picker 不跨 scope 自动弹到新 draft", async () => {
    await ensureCompletedTask();
    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "completed task 打开模型 picker");

    await startNewV4Draft();
    await waitForNoComposerPickerOpen("completed task→draft");
  });

  it("completed task → draft 后独立重新水合自定义 slash command", async () => {
    // Bug 原因：task → draft 会保留模型目录但清空 slashCommands；旧水合门禁只检查
    // 模型目录，导致真实 user-scope 自定义命令永远不会重新进入 composer 候选。
    await ensureCompletedTask();
    await ensureCustomSlashHydratedInDraft();
  });

  it("draft → 已知 completed task 后保留自定义 slash command", async () => {
    // Bug 原因：Mocha grep 会跳过负责建 task 与水合 draft 的前置 it；依赖 describe 内
    // 变量会让本 case 无法独立回放。这里幂等补齐 S03 自身的前置状态，整组运行仍复用已有状态。
    const taskId = await ensureCompletedTask();
    await ensureCustomSlashHydratedInDraft();
    // Bug 原因：旧 task 导航把 workspace 级 slashCommands 清空，但 session projection
    // 只恢复会话状态，不会回填 composer 消费的 workspace catalog。
    await selectV4TaskById(taskId);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
      timeoutMsg: "draft → 已知 task 后 v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption(CUSTOM_SLASH_OPTION_ID);
    expect(await getV4SlashOptionIds()).toContain(CUSTOM_SLASH_OPTION_ID);

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "已知 task slash 回归断言后没有清空 composer",
    });
  });
});
