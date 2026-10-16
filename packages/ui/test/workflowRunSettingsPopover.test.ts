// @vitest-environment jsdom

// 「配置」弹层（docs/dynamic-workflow/presentation.md「The settings popover」）与 run 卡上的 Configure 钮
// （「The run card」）、转写里的设置行（「The settings turn」）：真实 DOM 上钉字段、后果句、Apply 发出去的
// 载荷、被拒的那一行，以及卡上按钮的位置与门控。纯规则在 workflowRunSettings.test.ts 里穷举。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, createRef, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER } from "@zcode/shared";
import type { CommandAck, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));

/** 模型清单：一个 provider、两个模型，其中一个有思考档。 */
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

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import {
  WorkflowRunSettingsPopover,
  type WorkflowRunSettingsHost,
} from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
// eslint-disable-next-line import/first
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
// eslint-disable-next-line import/first
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
// eslint-disable-next-line import/first
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

beforeAll(() => {
  // Radix Popper 量尺寸用 ResizeObserver；jsdom 没有。
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  modelRead.state = { status: "ready", view: VIEW };
});

afterEach(() => {
  cleanup();
});

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "run-a",
    toolCallId: "tool-a",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    concurrencyCeiling: 13,
    ...overrides,
  };
}

function hostWith(apply: (change: unknown) => Promise<CommandAck>): WorkflowRunSettingsHost {
  return {
    workspacePath: "/w",
    sessionModel: { providerId: "zhipu", modelId: "glm-5.3" },
    apply: apply as WorkflowRunSettingsHost["apply"],
  };
}

function renderPopover(
  run: WorkflowRunState,
  options: {
    locale?: "en-US" | "zh-CN";
    apply?: (change: unknown) => Promise<CommandAck>;
    onAccepted?: (accepted: unknown) => void;
    onOpenChange?: (open: boolean) => void;
  } = {},
) {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const anchorRef = createRef<HTMLElement | null>() as { current: HTMLElement | null };
  anchorRef.current = anchor;
  const apply = options.apply ?? vi.fn(async () => ({ status: "accepted" }) as CommandAck);
  return {
    apply,
    view: render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: options.locale ?? "en-US" },
        createElement(WorkflowRunSettingsPopover, {
          anchorRef,
          host: hostWith(apply),
          onOpenChange: options.onOpenChange ?? vi.fn(),
          open: true,
          run,
          ...(options.onAccepted === undefined ? {} : { onAccepted: options.onAccepted }),
        }),
      ),
    ),
  };
}

describe("WorkflowRunSettingsPopover 字段", () => {
  it("起点是 run 自己的设置：模型名、默认并发提示；什么都没改时没有后果句、Apply 禁用", () => {
    renderPopover(
      runState({
        subagentModel: "zhipu/glm-5.3",
        concurrency: { cap: 13, ceiling: 13, limit: 4 },
      }),
    );
    expect(screen.getByText("Configure workflow")).toBeTruthy();
    expect(screen.getByTestId("workflow-run-settings-model-trigger").textContent).toContain(
      "glm-5.3",
    );
    expect(screen.getByTestId<HTMLInputElement>("workflow-run-settings-bound-value").value).toBe(
      "4",
    );
    expect(screen.getByTestId("workflow-run-settings-bound").textContent).toContain("default 13");
    // 后果句那一行留着高度、但是空的：第一次改动时页脚不往下跳。
    expect(screen.getByTestId("workflow-run-settings-consequence").textContent).toBe("");
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      true,
    );
    // glm-5.3 没有思考档：不画思考档控件。
    expect(screen.queryByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeNull();
  });

  it("后果句跟着改动走：在跑的 run 只改并发念「就地生效」，改回原值又空下来", () => {
    renderPopover(
      runState({
        subagentModel: "zhipu/glm-5.3",
        concurrency: { cap: 13, ceiling: 13, limit: 4 },
      }),
    );
    const consequence = () => screen.getByTestId("workflow-run-settings-consequence").textContent;
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    expect(consequence()).toBe("Applies to this run right away; no new run is started.");
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    expect(consequence()).toBe("");
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      true,
    );
  });

  it("zh-CN：跑在会话模型上、上限在默认——触发器带「会话模型」徽标，提示念「= 默认」，加号仍可按", () => {
    renderPopover(runState({ status: "stopped", stopReason: "user", resumable: true }), {
      locale: "zh-CN",
    });
    expect(screen.getByText("配置工作流")).toBeTruthy();
    expect(screen.getByTestId("workflow-run-settings-model-badge").textContent).toBe("会话模型");
    expect(screen.getByTestId("workflow-run-settings-bound").textContent).toContain("= 默认");
    // 默认是起点不是天花板：停在默认上照样能往上加。
    expect(
      screen.getByTestId<HTMLButtonElement>("workflow-run-settings-bound-increase").disabled,
    ).toBe(false);
    expect(screen.getByTestId("workflow-run-settings-consequence").textContent).toBe("");
    // 改了才有后果句：停下的 run 不论改哪一项都是另起一次接着跑。
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    expect(screen.getByTestId("workflow-run-settings-consequence").textContent).toBe(
      "将以新设置另起一次运行接着跑，已完成的步骤会保留。",
    );
  });

  it("有思考档的模型：触发器旁边出现思考档控件", () => {
    renderPopover(runState({ subagentModel: "zhipu/glm-5.3-flash$low" }));
    expect(screen.getByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeTruthy();
  });

  it("run 的模型已不在清单里：「不可用」徽标，改了别的也不能 Apply（agent 只会回 model_unavailable）", () => {
    renderPopover(runState({ subagentModel: "gone/model-x" }));
    expect(screen.getByTestId("workflow-run-settings-model-badge").textContent).toBe("unavailable");
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      true,
    );
  });

  it("agent 没有模型目录：模型那一格换成一句话，上限仍可调", () => {
    modelRead.state = { status: "ready", view: { revision: 1, providers: [] } };
    renderPopover(runState());
    expect(screen.getByTestId("workflow-run-settings-model").textContent).toContain(
      "This agent has no model catalog; subagents stay on the session model.",
    );
    expect(screen.getByTestId("workflow-run-settings-bound-decrease")).toBeTruthy();
  });

  it("默认未知（老 CLI）：没有默认提示，数字可以直接敲", () => {
    renderPopover(runState({ concurrencyCeiling: undefined, concurrency: undefined }));
    const input = screen.getByTestId<HTMLInputElement>("workflow-run-settings-bound-value");
    expect(input.value).toBe("");
    expect(screen.getByTestId("workflow-run-settings-bound").textContent).not.toContain("default");
    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("5");
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      false,
    );
  });
});

describe("WorkflowRunSettingsPopover Apply", () => {
  it("只发改过的那一项；被接受即关、把新 run 的两把钥匙交出去", async () => {
    const onAccepted = vi.fn();
    const onOpenChange = vi.fn();
    const { apply } = renderPopover(
      runState({ subagentModel: "zhipu/glm-5.3", concurrency: { cap: 13, ceiling: 13, limit: 4 } }),
      {
        apply: vi.fn(
          async () =>
            ({
              status: "accepted",
              commandId: "c",
              revisionAtDecision: 0,
              result: {
                type: "amendWorkflowRunSettings",
                runId: "run-b",
                toolCallId: "settings-1",
                supersededRunId: "run-a",
              },
            }) as CommandAck,
        ),
        onAccepted,
        onOpenChange,
      },
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    expect(apply).toHaveBeenCalledWith({ maxConcurrency: 3 });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onAccepted).toHaveBeenCalledWith({ runId: "run-b", toolCallId: "settings-1" });
  });

  it("从默认往上加：发出的是那个数，不是 null（默认是起点不是天花板）", async () => {
    const { apply } = renderPopover(runState(), {
      apply: vi.fn(
        async () =>
          ({
            status: "accepted",
            commandId: "c",
            revisionAtDecision: 0,
            result: { type: "amendWorkflowRunSettings", runId: "run-a", toolCallId: "settings-2" },
          }) as CommandAck,
      ),
    });
    expect(screen.getByTestId<HTMLInputElement>("workflow-run-settings-bound-value").value).toBe(
      "13",
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    expect(screen.getByTestId("workflow-run-settings-bound").textContent).toContain("default 13");
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    });
    expect(apply).toHaveBeenCalledWith({ maxConcurrency: 15 });
  });

  it("被拒：弹层不关，原因一行 + 诊断等宽块，Apply 重新可点；再改一个字段那一行就收起", async () => {
    const onOpenChange = vi.fn();
    renderPopover(runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }), {
      apply: vi.fn(
        async () =>
          ({
            status: "rejected",
            commandId: "c",
            revisionAtDecision: 0,
            reasonCode: "fault.command.workflowRunSettingsRejected.compile_failed",
            message: "L3:C1 Property 'ask' does not exist",
          }) as CommandAck,
      ),
      onOpenChange,
    });
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    });
    const rejection = await screen.findByTestId("workflow-run-settings-rejection");
    expect(rejection.textContent).toContain("no longer compiles");
    expect(rejection.querySelector("pre")?.textContent).toBe("L3:C1 Property 'ask' does not exist");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    expect(screen.queryByTestId("workflow-run-settings-rejection")).toBeNull();
  });

  it("zh-CN 的拒绝词：能力缺席", async () => {
    renderPopover(runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }), {
      locale: "zh-CN",
      apply: vi.fn(
        async () =>
          ({
            status: "rejected",
            commandId: "c",
            revisionAtDecision: 0,
            reasonCode: "fault.command.capabilityUnsupported",
          }) as CommandAck,
      ),
    });
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    });
    expect((await screen.findByTestId("workflow-run-settings-rejection")).textContent).toBe(
      "当前 agent 不支持从这里调整工作流设置。",
    );
  });
});

function summaryOf(run: WorkflowRunState): WorkflowRunCardSummary {
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    nodesSettled: 0,
    nodesTotal: 0,
    run,
    ...(run.resumable === true ? { resumable: true as const } : {}),
  };
}

describe("run 卡上的 Configure", () => {
  function renderCard(run: WorkflowRunState, withHost: boolean) {
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunDigest, {
          graph: undefined,
          name: "implement-verify",
          runId: run.runId,
          summary: summaryOf(run),
          testIdKey: "t",
          onCancel: vi.fn(),
          onResume: vi.fn(),
          onOpenRun: vi.fn(),
          ...(withHost ? { settingsHost: hostWith(vi.fn()) } : {}),
        }),
      ),
    );
  }

  it("在 Stop 之前、⤢ 之前；点它在自己下方开弹层，aria-expanded 跟着翻", () => {
    const view = renderCard(runState(), true);
    const configure = view.getByTestId("workflow-digest-configure");
    const cancel = view.getByTestId("workflow-digest-cancel");
    expect(
      configure.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(configure.getAttribute("aria-label")).toBe("Configure workflow");
    fireEvent.click(configure);
    expect(configure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("workflow-run-settings-popover")).toBeTruthy();
  });

  it("点弹层里的空白不会让卡收起（弹层的点击不冒泡到卡身）", () => {
    const view = renderCard(runState(), true);
    fireEvent.click(view.getByTestId("workflow-digest-configure"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-consequence"));
    expect(screen.getByTestId("workflow-run-settings-popover")).toBeTruthy();
  });

  it("宿主没给（只读、灰度关、run 不能配置）就没有这枚钮", () => {
    const view = renderCard(runState(), false);
    expect(view.queryByTestId("workflow-digest-configure")).toBeNull();
  });

  function renderDigests(
    run: WorkflowRunState,
    settings?: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const onAmendWorkflowRunSettings = vi.fn(async () => ({ status: "accepted" }) as CommandAck);
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationWorkflowDigests, {
          turnKey: "t",
          digests: [
            {
              key: "k",
              toolCallId: run.toolCallId ?? "tool-a",
              runId: run.runId,
              name: "implement-verify",
              graph: undefined,
              summary: summaryOf(run),
              ...(settings === undefined ? {} : { settings }),
              ...extra,
            } as never,
          ],
          context: {
            sessionId: "parent-a",
            workspacePath: "/w",
            onAmendWorkflowRunSettings,
          } as unknown as ConversationRowRenderContext,
        }),
      ),
    );
    return { view, onAmendWorkflowRunSettings };
  }

  it.each([
    ["running", runState(), true],
    ["errored", runState({ status: "errored" }), true],
    ["completed", runState({ status: "completed" }), false],
    [
      "superseded",
      runState({ status: "stopped", stopReason: "superseded", supersededBy: "run-b" }),
      false,
    ],
  ] as const)("接线层按 run 状态门控：%s", (_case, run, shown) => {
    const { view } = renderDigests(run);
    expect(view.queryByTestId("workflow-digest-configure") !== null).toBe(shown);
  });

  it("Apply 走宿主的 onAmendWorkflowRunSettings，带上这张卡的 runId", async () => {
    const { view, onAmendWorkflowRunSettings } = renderDigests(
      runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }),
    );
    fireEvent.click(view.getByTestId("workflow-digest-configure"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    });
    expect(onAmendWorkflowRunSettings).toHaveBeenCalledWith("run-a", { maxConcurrency: 3 });
  });

  it("设置轮：卡上方一行「已调整设置 · …」，普通卡没有", () => {
    const { view } = renderDigests(runState({ runId: "run-b", toolCallId: "settings-1" }), {
      amend: {
        predecessorRunId: "run-a",
        subagentModel: { to: "zhipu/glm-5.3-flash" },
        maxConcurrency: { from: 13, to: 4 },
        ceiling: 13,
      },
    });
    const row = view.getByTestId("workflow-settings-change-row");
    expect(row.textContent).toContain("已调整设置");
    expect(row.textContent).toContain("子代理改用 glm-5.3-flash");
    expect(row.textContent).toContain("最多 4 个同时运行");
    cleanup();
    const plain = renderDigests(runState());
    expect(plain.view.queryByTestId("workflow-settings-change-row")).toBeNull();
  });

  // 就地生效的设置轮（docs/dynamic-workflow/presentation.md「The settings turn」）：那一行是全部，
  // 它点名的 run 的卡在它启动的那一轮里——这里再画一张会读成第二次运行。
  it("就地生效的设置轮：只有那一行，没有卡", () => {
    const { view } = renderDigests(
      runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }),
      { amend: { maxConcurrency: { from: 13, to: 4 }, ceiling: 13 } },
      { rowOnly: true },
    );
    const row = view.getByTestId("workflow-settings-change-row");
    expect(row.textContent).toContain("已调整设置");
    expect(row.textContent).toContain("最多 4 个同时运行");
    // 卡身、Configure 钮、Stop 钮：一个都不在。
    expect(view.queryByTestId("workflow-digest-configure")).toBeNull();
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.container.querySelector('[data-testid^="workflow-run-digest-"]')).toBeNull();
  });
});
