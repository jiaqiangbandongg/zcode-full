// @vitest-environment jsdom

// 确认窗里可调的两项 run 设置（docs/dynamic-workflow/launch.md「Adjusting the settings in the window」；
// 外观与键盘见 docs/dynamic-workflow/presentation.md「The confirmation window」）：纯规则逐条穷举，
// 真实 DOM 上钉两句话、改过的那一行、选项描述、Allow 应答带出去的 content、「不可用」的门与 Shift+Tab。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER, type ZCodePermissionRequest } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));

/** 模型清单：一个 provider、两个模型，其中一个有思考档（与「配置」弹层的测试同一份）。 */
const VIEW = {
  revision: 1,
  providers: [
    {
      providerId: "zhipu",
      providerName: "Zhipu",
      config: { api: { type: "openai-chat-completions" } },
      models: [
        {
          modelId: "glm-5.3",
          config: { optionSpecs: { reasoningLevel: { values: [], map: "{}" } } },
        },
        {
          modelId: "glm-5.3-flash",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } } },
        },
      ],
    },
  ],
};
const modelRead = vi.hoisted(() => ({
  state: { status: "ready", view: null as unknown } as { status: string; view?: unknown },
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({ state: modelRead.state, reload: vi.fn() }),
}));

// 模型菜单的选择走真实组件，只把 props 记下来：测试直接调它的 onValueChange，不去驱动 Radix 菜单。
const capturedSelects = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/ModelConfigSelect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ModelConfigSelect.js")>();
  const react = await import("react");
  return {
    ...actual,
    ModelConfigSelect: (props: Record<string, unknown>) => {
      capturedSelects.push(props);
      return react.createElement(
        actual.ModelConfigSelect as unknown as (p: Record<string, unknown>) => ReactNode,
        props,
      );
    },
  };
});

const sendCommand = vi.hoisted(() => vi.fn());
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ sendCommand }),
}));

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { PermissionDialog } from "@/PermissionDialog.js";
// eslint-disable-next-line import/first
import {
  isWorkflowSettingsCarrier,
  workflowAdjustedOptionDescriptionId,
} from "@/permissionWorkflowSettings.js";
// eslint-disable-next-line import/first
import {
  initialWorkflowAskSettingsDraft,
  workflowAskSettingsChangedLines,
  workflowAskSettingsContent,
} from "@/components/workflow-timeline/workflowAskSettings.js";
// eslint-disable-next-line import/first
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
// eslint-disable-next-line import/first
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";

const SCRIPT = 'const r = await agent("a").ask<string>("do");';
const ALLOW = { optionId: "allowOnce", kind: "allowOnce", name: "Allow" };
const SESSION = {
  optionId: "allowSession",
  kind: "allowAlways",
  name: "Always allow in this session",
};
const DENY = { optionId: "deny", kind: "deny", name: "Deny" };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  modelRead.state = { status: "ready", view: VIEW };
  capturedSelects.length = 0;
  sendCommand.mockReset();
});

afterEach(() => {
  cleanup();
});

function workflowRequest(
  raw: Record<string, unknown>,
  overrides: Partial<ZCodePermissionRequest> = {},
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-1",
    description: "createWorkflow.runConfirmation",
    kind: "CreateWorkflow",
    title: "CreateWorkflow",
    options: [
      { ...ALLOW, response: { decision: "allow" } },
      { ...SESSION, response: { decision: "allow" } },
      { ...DENY, response: { decision: "deny" } },
    ],
    raw: { name: "Research", script: SCRIPT, ...raw },
    ...overrides,
  };
}

const ADJUSTABLE = { adjustable_settings: { subagent_model: true, concurrency_ceiling: 13 } };

function renderDialog(
  request: ZCodePermissionRequest,
  options: { locale?: "en-US" | "zh-CN"; responding?: boolean } = {},
) {
  const onRespond = vi.fn();
  const element = (next: ZCodePermissionRequest) =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: options.locale ?? "en-US" },
      createElement(PermissionDialog, {
        request: next,
        onRespond,
        workspacePath: "/w",
        workflowSessionModel: { providerId: "zhipu", modelId: "glm-5.3" },
        ...(options.responding === undefined ? {} : { responding: options.responding }),
      }),
    );
  const view = render(element(request));
  return { onRespond, rerender: (next: ZCodePermissionRequest) => view.rerender(element(next)) };
}

function modelLine(): HTMLElement {
  return screen.getByTestId("workflow-permission-settings-model");
}
function boundLine(): HTMLElement {
  return screen.getByTestId("workflow-permission-settings-bound");
}
function boundValue(): HTMLInputElement {
  return screen.getByTestId<HTMLInputElement>("workflow-permission-settings-bound-value");
}
function option(name: string): HTMLElement {
  return screen.getByRole("option", { name });
}
function pickModel(value: string) {
  const onValueChange = capturedSelects.at(-1)?.onValueChange as (value: string) => void;
  act(() => onValueChange(value));
}

describe("纯规则：起点、应答 content、改过的行", () => {
  it("起点读入参：缺席的模型是会话模型，缺席的上界是默认并发，默认也未知即空", () => {
    expect(initialWorkflowAskSettingsDraft({}, 13)).toEqual({
      model: { kind: "session" },
      bound: 13,
    });
    expect(
      initialWorkflowAskSettingsDraft(
        { subagent_model: "zhipu/glm-5.3-flash$high", max_concurrency: 4 },
        13,
      ),
    ).toEqual({
      model: { kind: "model", providerId: "zhipu", modelId: "glm-5.3-flash", level: "high" },
      bound: 4,
    });
    expect(initialWorkflowAskSettingsDraft({}, undefined)).toEqual({
      model: { kind: "session" },
      bound: null,
    });
  });

  it("只发改过的字段；上界回到默认发 null，换回会话模型发 null，只改思考档也算改了模型", () => {
    const initial = initialWorkflowAskSettingsDraft(
      { subagent_model: "zhipu/glm-5.3-flash$low", max_concurrency: 4 },
      13,
    );
    expect(workflowAskSettingsContent(initial, initial, 13)).toBeUndefined();
    expect(workflowAskSettingsContent(initial, { ...initial, bound: 13 }, 13)).toEqual({
      max_concurrency: null,
    });
    // 默认是起点不是上限：高于它的数原样发出去。
    expect(workflowAskSettingsContent(initial, { ...initial, bound: 40 }, 13)).toEqual({
      max_concurrency: 40,
    });
    expect(
      workflowAskSettingsContent(initial, { ...initial, model: { kind: "session" } }, 13),
    ).toEqual({
      subagent_model: null,
    });
    const levelOnly = {
      ...initial,
      model: {
        kind: "model" as const,
        providerId: "zhipu",
        modelId: "glm-5.3-flash",
        level: "high",
      },
    };
    expect(workflowAskSettingsContent(initial, levelOnly, 13)).toEqual({
      subagent_model: "zhipu/glm-5.3-flash$high",
    });
    expect(workflowAskSettingsChangedLines(initial, levelOnly, 13)).toEqual({
      model: true,
      bound: false,
    });
  });

  it("只有放行的两项带设置；改过设置时换描述的也只有它们", () => {
    expect(isWorkflowSettingsCarrier({ ...ALLOW, response: { decision: "allow" } })).toBe(true);
    expect(isWorkflowSettingsCarrier({ ...SESSION, response: { decision: "allow" } })).toBe(true);
    expect(isWorkflowSettingsCarrier({ ...DENY, response: { decision: "deny" } })).toBe(false);
    expect(workflowAdjustedOptionDescriptionId("chat.permission.allowOnce.description")).toBe(
      "chat.permission.workflow.allowOnce.adjusted",
    );
    expect(
      workflowAdjustedOptionDescriptionId("chat.permission.workflow.allowForSession.description"),
    ).toBe("chat.permission.workflow.allowForSession.adjusted");
    expect(workflowAdjustedOptionDescriptionId("chat.permission.denyOnce.description")).toBe(
      "chat.permission.denyOnce.description",
    );
  });
});

describe("确认窗里的两句话", () => {
  it("没设过的调用也说出将会发生什么：模型在上（会话模型徽标），上界在下（= 默认），没有「原为」", () => {
    renderDialog(workflowRequest(ADJUSTABLE));
    const block = screen.getByTestId("workflow-permission-settings");
    expect(block.textContent?.indexOf("Subagents run on")).toBeLessThan(
      block.textContent?.indexOf("At most") ?? -1,
    );
    expect(modelLine().textContent).toContain("glm-5.3");
    expect(modelLine().textContent).toContain("session model");
    expect(boundValue().value).toBe("13");
    expect(boundLine().textContent).toContain("subagents at once");
    expect(boundLine().textContent).toContain("= default");
    // 默认不是天花板：停在默认上照样能往上加。
    expect(
      screen.getByTestId<HTMLButtonElement>("workflow-permission-settings-bound-increase").disabled,
    ).toBe(false);
    expect(screen.queryByTestId("workflow-permission-settings-model-was")).toBeNull();
    expect(screen.queryByTestId("workflow-permission-settings-bound-was")).toBeNull();
    // 旧的纯文本行不再出现。
    expect(screen.queryByTestId("workflow-permission-max-concurrency")).toBeNull();
    expect(option("Allow").textContent).toContain("Allow only this time");
  });

  it("改上界：那一行加粗并带「· was 13 ↺」，前两个选项换描述，Allow 带 content；↺ 放回去即不带", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    expect(boundValue().value).toBe("11");
    expect(boundLine().getAttribute("data-changed")).toBe("true");
    expect(boundValue().className).toContain("font-medium");
    expect(boundLine().textContent).toContain("default 13");
    expect(screen.getByTestId("workflow-permission-settings-bound-was").textContent).toBe(
      "· was 13",
    );
    expect(option("Allow").textContent).toContain("Run once with the adjusted settings");
    expect(option("Always allow in this session").textContent).toContain(
      "later runs are not asked and carry their own",
    );

    fireEvent.click(option("Allow"));
    expect(onRespond).toHaveBeenLastCalledWith(
      "perm-1",
      expect.objectContaining({ optionId: "allowOnce" }),
      undefined,
      { max_concurrency: 11 },
    );

    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-reset"));
    expect(boundValue().value).toBe("13");
    expect(screen.queryByTestId("workflow-permission-settings-bound-was")).toBeNull();
    expect(option("Allow").textContent).toContain("Allow only this time");
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall).toEqual([
      "perm-1",
      expect.objectContaining({ optionId: "allowOnce" }),
      undefined,
    ]);
  });

  it("换模型：content 是规范串，「原为」说起点（会话模型）；会话免确认同样带着这一次的设置", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    pickModel(encodeCustomModelValue("zhipu", "glm-5.3-flash"));
    expect(modelLine().getAttribute("data-changed")).toBe("true");
    expect(screen.getByTestId("workflow-permission-settings-model-was").textContent).toBe(
      "· was Zhipu/glm-5.3 · session model",
    );

    fireEvent.click(option("Always allow in this session"));
    fireEvent.click(option("Always allow in this session"));
    const content = onRespond.mock.lastCall?.[3] as { subagent_model?: string };
    expect(onRespond.mock.lastCall?.[1]).toMatchObject({ optionId: "allowSession" });
    expect(content.subagent_model?.startsWith("zhipu/glm-5.3-flash")).toBe(true);
    expect(Object.keys(content)).toEqual(["subagent_model"]);
  });

  it("所选模型有思考档：模型芯片旁边出现思考档芯片；没有档位的模型没有它", () => {
    renderDialog(workflowRequest(ADJUSTABLE));
    // 起点是会话模型 glm-5.3（夹具里没有档位）。
    expect(screen.queryByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeNull();
    pickModel(encodeCustomModelValue("zhipu", "glm-5.3-flash"));
    expect(screen.getByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeTruthy();
  });

  it("拒绝不带设置：改过之后点 Deny 也只是普通拒绝", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Deny"));
    fireEvent.click(option("Deny"));
    expect(onRespond.mock.lastCall).toEqual([
      "perm-1",
      expect.objectContaining({ optionId: "deny" }),
      undefined,
    ]);
  });

  it("入参里的模型已不在清单：「不可用」徽标，Allow 与确认键等用户换一个，Deny 照常", async () => {
    const { onRespond } = renderDialog(
      workflowRequest({ ...ADJUSTABLE, subagent_model: "gone/model-x" }),
    );
    expect(screen.getByTestId("workflow-permission-settings-model-unavailable").textContent).toBe(
      "unavailable",
    );
    await waitFor(() => expect(option("Allow").getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(option("Allow"));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Confirm" }).disabled).toBe(true);

    pickModel(encodeCustomModelValue("zhipu", "glm-5.3"));
    await waitFor(() => expect(option("Allow").getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ subagent_model: "zhipu/glm-5.3" });
  });

  it("agent 没有模型目录：模型那一行是一句话，上界照样可调", () => {
    const { onRespond } = renderDialog(
      workflowRequest({ adjustable_settings: { subagent_model: false, concurrency_ceiling: 8 } }),
    );
    expect(modelLine().textContent).toBe(
      "Subagents stay on the session model· this agent has no model catalog",
    );
    expect(screen.queryByTestId("workflow-permission-settings-model-trigger")).toBeNull();
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ max_concurrency: 7 });
  });

  it("选不了模型、入参却带着一个（沿用来的）：照实说它，不说「沿用会话模型」", () => {
    renderDialog(
      workflowRequest({
        adjustable_settings: { subagent_model: false, concurrency_ceiling: 8 },
        subagent_model: "zhipu/glm-5.3-flash",
      }),
    );
    // 夹具的 provider 不是内置家族：名字是「provider 名/模型 id」，与菜单同一条拼名规则。
    expect(modelLine().textContent).toBe("Subagents run on Zhipu/glm-5.3-flash");
  });

  it("天花板未知、调用也没设上界：步进器留空，句尾「不设上限」；敲一个数就成了调整", () => {
    const { onRespond } = renderDialog(
      workflowRequest({ adjustable_settings: { subagent_model: true } }),
    );
    expect(boundValue().value).toBe("");
    expect(screen.getByTestId("workflow-permission-settings-bound-tail").textContent).toBe(
      "· no limit of its own",
    );
    fireEvent.change(boundValue(), { target: { value: "5" } });
    expect(screen.queryByTestId("workflow-permission-settings-bound-tail")).toBeNull();
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ max_concurrency: 5 });
  });

  it("应答在途：控件与选项一起禁用", () => {
    renderDialog(workflowRequest(ADJUSTABLE), { responding: true });
    expect(boundValue().disabled).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("workflow-permission-settings-bound-decrease").disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("workflow-permission-settings-model-trigger").disabled,
    ).toBe(true);
  });

  it("zh-CN：两句与「原为」", () => {
    renderDialog(workflowRequest(ADJUSTABLE), { locale: "zh-CN" });
    expect(modelLine().textContent).toContain("子代理运行在");
    expect(boundLine().textContent).toContain("最多");
    expect(boundLine().textContent).toContain("个子代理同时运行");
    expect(boundLine().textContent).toContain("= 默认");
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    expect(boundLine().textContent).toContain("默认 13");
    expect(screen.getByTestId("workflow-permission-settings-bound-was").textContent).toBe(
      "· 原为 13",
    );
    expect(
      screen.getByTestId("workflow-permission-settings-bound-reset").getAttribute("title"),
    ).toBe("恢复原值");
    expect(option("允许").textContent).toContain("按调整后的设置运行一次");
  });

  it("换请求：设置回到新入参的起点，上一个窗的改动不带进下一个", () => {
    const { onRespond, rerender } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    rerender(workflowRequest(ADJUSTABLE, { requestId: "perm-2" }));
    expect(boundValue().value).toBe("13");
    expect(option("Allow").textContent).toContain("Allow only this time");
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall).toEqual([
      "perm-2",
      expect.objectContaining({ optionId: "allowOnce" }),
      undefined,
    ]);
  });
});

// 脚本给某些子代理点名了模型（docs/dynamic-workflow/launch.md「The window」）：窗不逐名列出——那是
// 作者模型的选择——只把模型那一句改口「默认」；应答里也永远没有改它们的字段。
describe("脚本点名了模型", () => {
  const BINDINGS = {
    model_bindings: { "GLM-5.3-Flash": "zhipu/glm-5.3-flash$low", judge: "zhipu/glm-5.3" },
  };

  it("不逐名列出，模型那一句说「默认」；只有一个模型菜单", () => {
    renderDialog(workflowRequest({ ...ADJUSTABLE, ...BINDINGS }));
    const text = screen.getByTestId("workflow-permission-settings").textContent ?? "";
    expect(modelLine().textContent).toContain("By default, subagents run on");
    expect(text).not.toContain("judge");
    expect(text).not.toContain("glm-5.3-flash");
    expect(screen.getAllByTestId("workflow-permission-settings-model-trigger")).toHaveLength(1);
  });

  it("改设置后 Allow 只带那两项，不带 model_bindings", () => {
    const { onRespond } = renderDialog(workflowRequest({ ...ADJUSTABLE, ...BINDINGS }));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ max_concurrency: 12 });
  });

  it("没点名模型的脚本照旧说「子代理运行在」", () => {
    renderDialog(workflowRequest({ ...ADJUSTABLE, model_bindings: {} }));
    expect(modelLine().textContent).toContain("Subagents run on");
    expect(modelLine().textContent).not.toContain("By default");
  });

  it("选不了模型：「子代理默认沿用会话模型」", () => {
    renderDialog(
      workflowRequest({
        adjustable_settings: { subagent_model: false, concurrency_ceiling: 8 },
        ...BINDINGS,
      }),
    );
    expect(modelLine().textContent).toBe(
      "By default, subagents stay on the session model· this agent has no model catalog",
    );
  });

  it("zh-CN：「子代理默认运行在」", () => {
    renderDialog(workflowRequest({ ...ADJUSTABLE, ...BINDINGS }), { locale: "zh-CN" });
    expect(modelLine().textContent).toContain("子代理默认运行在");
  });

  it("旧 agent（纯文本）：同样不列名字，模型那一句说「默认」", () => {
    renderDialog(
      workflowRequest({ max_concurrency: 2, subagent_model: "zhipu/glm-5.3", ...BINDINGS }),
    );
    expect(screen.getByTestId("workflow-permission-subagent-model").textContent).toBe(
      "By default, subagents run on glm-5.3",
    );
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText).not.toContain("judge");
  });
});

describe("键盘", () => {
  it("第一个选项上的 Shift+Tab 离开列表、落到设置块的最后一个控件；其余选项上照旧在列表里循环", async () => {
    renderDialog(workflowRequest(ADJUSTABLE));
    const allow = option("Allow");
    allow.focus();
    fireEvent.keyDown(allow, { key: "Tab", shiftKey: true });
    // 默认不是天花板：停在默认上加号照样可按，所以最后一个可聚焦的控件是加号。
    expect(document.activeElement).toBe(
      screen.getByTestId("workflow-permission-settings-bound-increase"),
    );

    const session = option("Always allow in this session");
    session.focus();
    fireEvent.keyDown(session, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(option("Allow")));
  });

  it("在数字框里敲的键留在数字框：选项的数字快捷键不生效", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.keyDown(boundValue(), { key: "1" });
    fireEvent.keyDown(boundValue(), { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe("旧 agent（入参没有 adjustable_settings）", () => {
  it("只画调用设了的字段，纯文本，模型在上、上界在下；没有控件", () => {
    renderDialog(workflowRequest({ max_concurrency: 2, subagent_model: "zhipu/glm-5.3-flash" }));
    expect(screen.queryByTestId("workflow-permission-settings")).toBeNull();
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Subagents run on glm-5.3-flash")).toBeLessThan(
      blockText.indexOf("At most 2 subagents at once"),
    );
  });
});

describe("V4 宿主", () => {
  it("把改过的设置放进 resolveInteraction.answer.content", async () => {
    sendCommand.mockResolvedValue({ status: "accepted", commandId: "c", revisionAtDecision: 0 });
    const snapshot = {
      sessionId: "sess-1",
      config: { provider: "zhipu", model: "glm-5.3" },
      pendingInteractions: [
        {
          interactionId: "ask-1",
          kind: "permission",
          anchorRowId: 3,
          createdAt: 1,
          payload: {
            kind: "permission",
            toolName: "CreateWorkflow",
            toolCallId: "tool-1",
            summary: "createWorkflow.runConfirmation",
            options: [
              { optionId: "allowOnce", kind: "allowOnce", label: "Allow" },
              { optionId: "deny", kind: "deny", label: "Deny" },
            ],
            detail: { name: "Research", script: SCRIPT, ...ADJUSTABLE },
          },
        },
      ],
    } as unknown as ConversationSnapshot;
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/w",
          snapshot,
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Allow"));
    await waitFor(() => expect(sendCommand).toHaveBeenCalled());
    const envelope = sendCommand.mock.calls
      .map(([sent]) => sent as { type: string; payload: { answer?: unknown } })
      .find((sent) => sent.type === "resolveInteraction");
    expect(envelope?.payload.answer).toEqual({
      optionId: "allowOnce",
      content: { max_concurrency: 12 },
    });
  });
});
