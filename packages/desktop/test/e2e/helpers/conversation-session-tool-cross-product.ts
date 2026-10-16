import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2ERuntimePath } from "./e2e-runtime-paths.js";

export const TOOL_CROSS_PRODUCT_ROOT = resolveE2ERuntimePath(
  "conversation-session-tool-cross-product",
);
export const TOOL_CROSS_PRODUCT_MARKER_PREFIX = "E2E_TOOL_CROSS_PRODUCT";
export const TOOL_CROSS_PRODUCT_READ_FILE = join(
  TOOL_CROSS_PRODUCT_ROOT,
  "read-fixture.txt",
);
export const TOOL_CROSS_PRODUCT_GLOB_FILE = join(
  TOOL_CROSS_PRODUCT_ROOT,
  "glob-fixture.e2e",
);
export const TOOL_CROSS_PRODUCT_GREP_FILE = join(
  TOOL_CROSS_PRODUCT_ROOT,
  "grep-fixture.txt",
);

export type ToolCrossProductScenario = "compact" | "fork" | "goal";

export interface ToolCrossProductCase {
  markerName: string;
  toolName: string;
  historyAssertion?: "visibleToolBlock" | "providerRequest";
  providerHistoryMarker?: string;
}

export const TOOL_CROSS_PRODUCT_CASES: ToolCrossProductCase[] = [
  { markerName: "READ", toolName: "Read" },
  { markerName: "WRITE", toolName: "Write" },
  { markerName: "EDIT", toolName: "Edit" },
  { markerName: "BASH", toolName: "Bash" },
  { markerName: "GLOB", toolName: "Glob" },
  { markerName: "GREP", toolName: "Grep" },
  { markerName: "WEBFETCH", toolName: "WebFetch" },
  {
    markerName: "TODO_READ",
    toolName: "TodoRead",
    historyAssertion: "providerRequest",
    providerHistoryMarker: "toolu_e2e_tool_cross_product_todo_read",
  },
  { markerName: "TODO_WRITE", toolName: "TodoWrite" },
  { markerName: "GOAL_READ", toolName: "GoalRead" },
  {
    markerName: "ENTER_PLAN_MODE",
    toolName: "EnterPlanMode",
    historyAssertion: "providerRequest",
    providerHistoryMarker: "toolu_e2e_tool_cross_product_enter_plan_mode",
  },
  { markerName: "EXIT_PLAN_MODE", toolName: "ExitPlanMode" },
  { markerName: "ASK_USER_QUESTION", toolName: "AskUserQuestion" },
  { markerName: "READ_SESSION_CONTEXT", toolName: "ReadSessionContext" },
  { markerName: "SEND_MESSAGE", toolName: "SendMessage" },
  { markerName: "AGENT", toolName: "Agent" },
  { markerName: "SKILL", toolName: "Skill" },
  // 修复原因：当前 desktop E2E 的 agent runtime 没有注册 Workflow 工具。
  // replay fixture 若强制调用 Workflow 会稳定得到 "Tool not found"，后续 compact/fork/goal
  // 断言验证的是失败工具卡而不是工具历史能力，应该从正式叉乘集合剪掉。
];

export function markerForToolCase(toolCase: ToolCrossProductCase) {
  return `${TOOL_CROSS_PRODUCT_MARKER_PREFIX}_${toolCase.markerName}`;
}

export function buildToolCrossProductPrompt(
  toolCase: ToolCrossProductCase,
  scenario: ToolCrossProductScenario,
  runId: string,
) {
  return [
    `${markerForToolCase(toolCase)}_${scenario.toUpperCase()}_${runId}:`,
    `Trigger the ${toolCase.toolName} tool exactly once.`,
    'Then reply with exactly "upstream-e2e-ok" and no other text.',
  ].join(" ");
}

export async function prepareToolCrossProductFixtures() {
  await cleanupToolCrossProductFixtures();
  await mkdir(TOOL_CROSS_PRODUCT_ROOT, { recursive: true });
  await writeFile(
    TOOL_CROSS_PRODUCT_READ_FILE,
    [
      "E2E_TOOL_RESULT_READ",
      "E2E_TOOL_RESULT_GREP",
      "This file is read by the conversation tool cross product e2e.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    TOOL_CROSS_PRODUCT_GLOB_FILE,
    "E2E_TOOL_RESULT_GLOB\n",
    "utf-8",
  );
  await writeFile(
    TOOL_CROSS_PRODUCT_GREP_FILE,
    "E2E_TOOL_RESULT_GREP content search fixture\n",
    "utf-8",
  );
}

export async function cleanupToolCrossProductFixtures() {
  await rm(TOOL_CROSS_PRODUCT_ROOT, { recursive: true, force: true });
}

export async function ensureToolCrossProductFullAccessMode() {
  if (await isFullAccessModeSelected()) {
    return;
  }
  // Bug 根因：长 suite 中上一个 mode 选择器可能仍处于打开状态；再次点击 trigger
  // 会把菜单关闭，后续就会稳定报“找不到 Full access”。只在当前没有可见目标项时
  // 打开选择器，避免 toggle 竞态。
  if (!(await hasVisibleFullAccessModeItem())) {
    await clickModeTrigger();
  }
  await clickFullAccessModeItem();
  await browser.waitUntil(async () => isFullAccessModeSelected(), {
    timeout: 30000,
    timeoutMsg: "工具叉乘 e2e 没有切换到 Full access/yolo mode",
  });
}

async function hasVisibleFullAccessModeItem(): Promise<boolean> {
  const normalizeText = (value: string | null | undefined) =>
    (value ?? "").replace(/\u00a0/g, " ").trim();
  const items = await browser.$$('[data-slot="select-item"],[role="option"]');
  for (const item of items) {
    if (!(await item.isDisplayed()) || !(await item.isEnabled())) {
      continue;
    }
    const value = await item.getAttribute("data-value");
    const text = normalizeText(await item.getText());
    if (
      value === "yolo" ||
      ["Full access", "完全访问", "Yolo", "全自动模式"].some((expected) =>
        text.includes(expected),
      )
    ) {
      return true;
    }
  }
  return false;
}

export async function respondToToolCrossProductBlockers() {
  const result = (await browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const clickFirstPermissionOption = () => {
      const listbox = Array.from(
        document.querySelectorAll<HTMLElement>('[role="listbox"]'),
      ).find((element) => {
        const label = normalizeText(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      });
      const option = listbox?.querySelector<HTMLButtonElement>(
        'button[role="option"]',
      );
      option?.click();
      return Boolean(option);
    };
    const clickFirstQuestionOption = () => {
      const listbox = Array.from(
        document.querySelectorAll<HTMLElement>('[role="listbox"]'),
      ).find((element) =>
        normalizeText(element.getAttribute("aria-label")).includes(
          "E2E_TOOL_CROSS_PRODUCT_ASK_USER_QUESTION",
        ),
      );
      const option = listbox?.querySelector<HTMLButtonElement>(
        'button[role="option"]',
      );
      option?.click();
      return Boolean(option);
    };

    const clickPlanApprovalSubmit = () => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
      const body = document.querySelector<HTMLElement>(
        '[data-elicitation-dialog-body="true"]',
      );
      const footer = document.querySelector<HTMLElement>(
        '[data-elicitation-dialog-footer="true"]',
      );
      const hasApproveOption = Array.from(
        body?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
      ).some((button) =>
        ["Approve", "批准"].some((label) =>
          normalizeText(button.textContent).includes(label),
        ),
      );
      const submit = Array.from(
        footer?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((button) =>
        ["Submit", "提交"].includes(normalizeText(button.textContent)),
      );
      if (!hasApproveOption || !submit || submit.disabled) {
        return false;
      }
      submit.click();
      return true;
    };

    return {
      elicitationClicked: clickFirstQuestionOption(),
      planApprovalClicked: clickPlanApprovalSubmit(),
      permissionClicked: clickFirstPermissionOption(),
    };
  })) as {
    elicitationClicked: boolean;
    planApprovalClicked: boolean;
    permissionClicked: boolean;
  };

  if (
    result.elicitationClicked ||
    result.planApprovalClicked ||
    result.permissionClicked
  ) {
    // Bug 根因：ExitPlanMode 在 V4 中走独立计划审批弹窗，不再是 legacy
    // PermissionDialog；只点击 permission option 会让整轮永久停在 interaction。
    await browser.pause(250);
  }
  return result;
}

async function isFullAccessModeSelected() {
  const result = (await browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const store = (
      window as typeof window & {
        __zcodeSessionStoreE2E?: {
          getState?: () => {
            workspaces?: Record<
              string,
              {
                activeTaskId?: string | null;
                configOptions?: Array<ConfigOptionLike> | null;
                taskConfigOptionsByTaskId?: Record<
                  string,
                  Array<ConfigOptionLike>
                >;
              }
            >;
          };
        };
      }
    ).__zcodeSessionStoreE2E;
    const workspaceValues: string[] = [];
    const activeTaskValues: string[] = [];
    const collect = (
      options: Array<ConfigOptionLike> | null | undefined,
      target: string[],
    ) => {
      for (const option of options ?? []) {
        if (
          option.type === "select" &&
          (option.category === "mode" || option.id === "mode") &&
          typeof option.currentValue === "string"
        ) {
          target.push(option.currentValue);
        }
      }
    };
    for (const workspace of Object.values(
      store?.getState?.().workspaces ?? {},
    )) {
      collect(workspace.configOptions, workspaceValues);
      const activeTaskId = workspace.activeTaskId;
      if (activeTaskId) {
        collect(
          workspace.taskConfigOptionsByTaskId?.[activeTaskId],
          activeTaskValues,
        );
      }
    }

    const labels = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button[aria-label="Switch mode"],button[aria-label="切换模式"]',
      ),
    )
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => normalizeText(element.textContent));
    const labelShowsYolo = labels.some((label) =>
      ["Full access", "完全访问", "Yolo", "全自动模式"].some((expected) =>
        label.includes(expected),
      ),
    );

    return {
      activeTaskValues,
      labels,
      workspaceValues,
      // Bug 根因：EnterPlanMode 后 workspace default 仍是 yolo，但 active task 已是 plan；
      // 旧逻辑聚合后只要看到任意 yolo 就误判。可见 V4 trigger 是当前 pane 权威值，
      // DOM 不可用时才按 active task → workspace default 的优先级降级。
      yolo: labels.length > 0
        ? labelShowsYolo
        : activeTaskValues.length > 0
          ? activeTaskValues.includes("yolo")
          : workspaceValues.includes("yolo"),
    };
  })) as {
    activeTaskValues: string[];
    labels: string[];
    workspaceValues: string[];
    yolo: boolean;
  };

  return result.yolo;
}

async function clickModeTrigger() {
  let latestReason = "not-started";
  await browser.waitUntil(
    async () => {
      const triggers = await browser.$$(
        'button[aria-label="Switch mode"],button[aria-label="切换模式"]',
      );
      for (const trigger of triggers) {
        if (!(await trigger.isDisplayed()) || !(await trigger.isEnabled())) {
          continue;
        }
        // Bug 根因：旧 helper 用 renderer click，长 suite 中会命中隐藏的旧 trigger，
        // 菜单看似打开但没有改变当前 task。只对当前可见控件走真实 WebDriver 点击。
        await trigger.click();
        return true;
      }
      latestReason = (await triggers.length) === 0 ? "missing" : "not-interactable";
      return false;
    },
    {
      timeout: 15000,
      timeoutMsg: `没有打开 mode 选择器: ${latestReason}`,
    },
  );
}

async function clickFullAccessModeItem() {
  let latestReason = "not-started";
  await browser.waitUntil(
    async () => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
      const items = await browser.$$('[data-slot="select-item"],[role="option"]');
      const visibleTexts: string[] = [];
      for (const item of items) {
        if (!(await item.isDisplayed()) || !(await item.isEnabled())) {
          continue;
        }
        const value = await item.getAttribute("data-value");
        const text = normalizeText(await item.getText());
        visibleTexts.push(text);
        if (
          value === "yolo" ||
          ["Full access", "完全访问", "Yolo", "全自动模式"].some((expected) =>
            text.includes(expected),
          )
        ) {
          // Bug 根因：旧 helper 未过滤可见性，可能点击已卸载菜单留下的隐藏 item；
          // 当前可见 item 用 WebDriver 点击，保证与用户选择 Full access 的路径一致。
          await item.click();
          return true;
        }
      }
      latestReason =
        (await items.length) === 0
          ? "missing"
          : `missing; visibleItems=${visibleTexts.join("|")}`;
      return false;
    },
    {
      timeout: 15000,
      timeoutMsg: `没有点击 Full access/yolo mode: ${latestReason}`,
    },
  );
}

interface ConfigOptionLike {
  category?: string;
  currentValue?: unknown;
  id?: string;
  type?: string;
}
