// @vitest-environment jsdom

// 终态通知行尾部的产物 chips 的**交互**（docs/dynamic-workflow/authoring.md「How the user sees them」）。
//
// chips 的在场性与「+N」在 v4ConversationTurnGroup.test.ts 里（那里是整条通知行的静态渲染面）；
// 点击与「不顺带把行展开」这两件事必须有真 DOM，所以单独一个 jsdom 文件。
//
// ⚠ 术语：chip 上的 artifact 是脚本经 `artifact.*` 交付给用户的产出，不是引擎内部那个
// 「脚本顶层返回值」的同名词（spec 的「术语」表）。
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_CHAT_WORKFLOW_ARTIFACT_CHIP } from "@zcode/shared";
import type { IPlatformService } from "@zcode/shared";
import type { AssistantTextRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({}),
}));

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { TooltipProvider } from "@/components/ui/tooltip.js";
// eslint-disable-next-line import/first
import { PlatformProvider } from "@/hooks/usePlatform.js";
// eslint-disable-next-line import/first
import { WorkflowNotificationToolRow } from "@/v4/WorkflowNotificationToolRow.js";
// eslint-disable-next-line import/first
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
// eslint-disable-next-line import/first
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
// eslint-disable-next-line import/first
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

const onOpenArtifact = vi.fn();

function terminal(
  artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>,
): WorkflowNotificationMeta {
  return {
    kind: "terminal",
    status: "completed",
    summary: "Workflow run completed.",
    durationMs: 1000,
    result: "done",
    resultForm: "prose",
    artifacts,
  };
}

// ToolLayout 的展开态按 `persistOpenKey` 记在模块级 Map 里，跨用例不清；每条用例给一个
// 自己的 key，否则一条用例把行展开会让后面那条看不到折叠头部上的 chips。
let rowSeq = 0;

function renderRow(notification: WorkflowNotificationMeta, options: { openable?: boolean } = {}) {
  rowSeq += 1;
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(WorkflowNotificationToolRow, {
          notification,
          runName: "flaky-test-triage",
          testIdKey: `unit-${rowSeq}`,
          theme: "system",
          ...(options.openable === false ? {} : { onOpenArtifact }),
        }),
      ),
    ),
  );
}

beforeEach(() => {
  cleanup();
  onOpenArtifact.mockClear();
  // 助手正文的代码块按 matchMedia 选配色；jsdom 没有它，整棵树会在渲染时炸掉。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

describe("通知行的产物 chips", () => {
  it("点 chip 把产物 id 交给宿主", () => {
    const view = renderRow(
      terminal([
        { id: "book", kind: "file", title: "审计报告", version: 2 },
        { id: "perf", kind: "chart", title: "每轮耗时", version: 1 },
      ]),
    );
    const chips = view.getAllByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP);
    expect(chips).toHaveLength(2);

    fireEvent.click(chips[1]!);
    expect(onOpenArtifact).toHaveBeenCalledWith("perf");
  });

  it("点 chip 不顺带把通知行展开——头部整条是折叠开关，chip 的点击必须止步于自己", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    const trigger = view.container.querySelector("[aria-expanded]");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP));
    expect(onOpenArtifact).toHaveBeenCalledWith("book");
    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("title 缺席时 chip 退回 id（facade 的缺省 title 本来就是 id）", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    expect(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP).textContent).toContain("book");
  });

  it("长标题在 chip 上截断，hover 提示里仍是完整的 kind 词 + 标题", () => {
    const long = "这是一个非常非常非常长的产物标题，长到必须在 chip 上被截断掉一部分才摆得下";
    const view = renderRow(terminal([{ id: "book", kind: "file", title: long, version: 1 }]));
    const chip = view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP);
    expect(chip.textContent?.endsWith("…")).toBe(true);
    expect(chip.getAttribute("title")).toBe(`文件 · ${long}`);
  });

  it("宿主没注入打开能力时 chip 不可点，点了也什么都不发生", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]), {
      openable: false,
    });
    const chip = view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP);
    expect(chip.hasAttribute("disabled")).toBe(true);
    fireEvent.click(chip);
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("点**禁用的** chip 同样不展开行：禁用只是把打开变成空操作，不是把 chip 交还给开关", () => {
    // 回归：strip 之前只在 chip 自己的 onClick 里阻断冒泡，而禁用按钮上 React 不跑 onClick，
    // 于是那一下点击一路冒到折叠开关，把整行展开了。
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]), {
      openable: false,
    });
    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.click(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP));

    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(view.queryByTestId("workflow-notification-artifacts")).toBeTruthy();
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("在 chip 上按 Enter 只打开产物，不顺带把行展开（键盘走的是开关的另一条通路）", () => {
    // 折叠开关是一个 role=button 的 div，它自己听 keydown 里的 Enter/Space；chip 上的按键
    // 会冒到它那里。strip 因此同时吞掉 click 与开合键。
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    fireEvent.keyDown(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP), { key: "Enter" });
    expect(view.container.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("展开之后 chips 收起——展开体自己在说结果，chips 再挂着只是重复", () => {
    const view = renderRow(terminal([{ id: "book", kind: "file", version: 1 }]));
    expect(view.queryByTestId("workflow-notification-artifacts")).toBeTruthy();

    fireEvent.click(view.container.querySelector("[aria-expanded]")!);
    expect(view.queryByTestId("workflow-notification-artifacts")).toBeNull();
  });
});

// ── 接线（docs/dynamic-workflow/authoring.md「How the user sees them」）──
// 上面钉的是 chip 把**产物 id** 交给上一层；这里钉上一层把 id 变成什么样的打开请求。
// 载荷带最新版的 `contentType`，宿主据它把 html 产物直接开成浏览器 tab 而不是开产物 tab；
// 载荷刻意不带 `sourcePath`（状态帧体积），所以请求里也不该凭空出现一个。
describe("ConversationTurnGroup 把通知行的 chip 变成打开请求", () => {
  const noopPlatform = {} as IPlatformService;

  function notificationUnit(
    artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>,
  ) {
    const header: TurnHeaderRow = {
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "backgroundResult",
      state: "completedSuccess",
      startedAt: 1_700_000_000_000,
      originMeta: {
        backgroundSource: "workflow",
        title: "flaky-test-triage",
        workId: "run-abc",
        workflowNotification: {
          kind: "terminal",
          status: "completed",
          summary: "Workflow run completed.",
          durationMs: 1000,
          artifacts,
        },
      },
    };
    const text: AssistantTextRow = {
      rowId: 2,
      entityId: "message-assistant-2",
      turnId: "turn-1",
      createdAt: 1_700_000_000_002,
      createdAtSeq: 2,
      kind: "assistantText",
      state: "complete",
      text: "后台总结最终段",
    };
    return buildConversationTurnRenderUnits([header, text])[0]!;
  }

  function renderTurn(
    artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>,
    onOpenWorkflowArtifact: (request: unknown) => void,
  ) {
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          PlatformProvider,
          { platform: noopPlatform },
          createElement(
            TooltipProvider,
            null,
            createElement(ConversationTurnGroup, {
              unit: notificationUnit(artifacts),
              context: {
                workspacePath: "/workspace",
                theme: "system",
                sessionId: "parent-a",
                onOpenWorkflowArtifact,
              } as unknown as ConversationRowRenderContext,
            }),
          ),
        ),
      ),
    );
  }

  it("带上载荷里那一枚的 contentType（html 产物据它直接开浏览器 tab）", () => {
    const spy = vi.fn();
    const view = renderTurn(
      [
        { id: "book", kind: "file", title: "审计报告", version: 2, contentType: "text/html" },
        { id: "perf", kind: "chart", title: "每轮耗时", version: 1 },
      ],
      spy,
    );

    fireEvent.click(view.getAllByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP)[0]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "run-abc",
      artifactId: "book",
      contentType: "text/html",
    });
  });

  it("载荷上没有 contentType 的那一枚不编一个出来", () => {
    const spy = vi.fn();
    const view = renderTurn([{ id: "perf", kind: "chart", title: "每轮耗时", version: 1 }], spy);

    fireEvent.click(view.getByTestId(TID_CHAT_WORKFLOW_ARTIFACT_CHIP));
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "run-abc",
      artifactId: "perf",
    });
  });
});
