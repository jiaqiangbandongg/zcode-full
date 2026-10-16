// @vitest-environment jsdom

// 完成卡的**活路径**（docs/dynamic-workflow/transcript-and-notifications.md「The card」「取数」）：会话在场时，通知
// 载荷（砍在 8 件）之上由活投影 / journal 补齐整份清单。
//
// Bug 原因（2026-09-14）：产物多的 run 的完成卡写「还有 … 个」而不是数字。`artifactsTruncated` 是
// **载荷**被砍的事实，卡却拿它决定「还有 N 个」的写法，而清单早已从 journal 补齐、数字明明可知。省略号
// 只在载荷是唯一来源时才诚实：冷渲染、老 CLI、journal 还没答上来的那几帧。
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunArtifact } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

const workflowRunArtifacts = vi.fn<() => Promise<{ artifacts: WorkflowRunArtifact[] }>>();
const workflowRunArtifactData = vi.fn();
const workflowRunArtifactRead = vi.fn();
let hasConversation = true;

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ workflowRunArtifacts, workflowRunArtifactData, workflowRunArtifactRead }),
  useHasV4Conversation: () => hasConversation,
}));

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
// eslint-disable-next-line import/first
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
// eslint-disable-next-line import/first
import type { WorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  hasConversation = true;
  // markdown 缩略的渲染器按 matchMedia 选代码块配色；jsdom 没有它。
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
  workflowRunArtifacts.mockReset();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
  workflowRunArtifactRead.mockReset();
  workflowRunArtifactRead.mockResolvedValue({
    dataBase64: btoa("# note"),
    mediaType: "text/markdown",
    totalBytes: 6,
    nextOffset: null,
  });
});

/** 12 件产物：交付物 + 11 份笔记；载荷只带前 8 件（交付物在前）并置 artifactsTruncated。 */
const IDS = Array.from({ length: 11 }, (_unused, index) => `note-${index + 1}`);
const payloadArtifacts: WorkflowTurnCompletion["artifacts"] = [
  { id: "report", kind: "markdown", title: "审计报告", version: 1, primary: true, description: "结论" },
  ...IDS.slice(0, 7).map((id) => ({ id, kind: "markdown" as const, title: id, version: 1 })),
];
const journalArtifacts: WorkflowRunArtifact[] = [
  {
    id: "report",
    kind: "markdown",
    title: "审计报告",
    description: "结论",
    version: 1,
    versions: [{ version: 1, publishedAt: 1, bytes: 6, primary: true }],
    itemCount: 0,
    primary: true,
  },
  ...IDS.map((id) => ({
    id,
    kind: "markdown" as const,
    title: id,
    version: 1,
    versions: [{ version: 1, publishedAt: 2, bytes: 6 }],
    itemCount: 0,
  })),
];

function renderCompletion(
  truncated: boolean,
  options: {
    sessionId?: string | null;
    artifacts?: WorkflowTurnCompletion["artifacts"];
    onOpenWorkflowArtifact?: (request: unknown) => void;
  } = {},
) {
  const completion: WorkflowTurnCompletion = {
    runId: "dwfrun-1",
    name: "audit",
    durationMs: 1_000,
    artifacts: options.artifacts ?? payloadArtifacts,
    artifactsTruncated: truncated,
    summary: undefined,
  };
  const context = {
    theme: "system",
    sessionId: options.sessionId === undefined ? "session-1" : options.sessionId,
    onOpenWorkflowArtifact: options.onOpenWorkflowArtifact ?? (() => {}),
  } as unknown as ConversationRowRenderContext;
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationWorkflowCompletion, { completion, context, turnKey: "t1" }),
    ),
  );
}

describe("ConversationWorkflowCompletion · 载荷砍过之后的 `+N`", () => {
  it("journal 答过之后写真实数字（12 件：行 + 5 行索引 + 「还有 6 个」），不再是省略号", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: journalArtifacts });
    const view = renderCompletion(true);
    await waitFor(() =>
      expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 6 个"),
    );
    expect(view.getAllByTestId("workflow-completion-line")).toHaveLength(5);
    expect(view.getByTestId("workflow-completion-card-t1").textContent).not.toContain("…");
  });

  it("老 CLI（查不到 journal）：清单可能确实不全，省略号保留；journal 未答上来的首帧也是省略号", async () => {
    let resolve!: (value: { artifacts: WorkflowRunArtifact[] }) => void;
    workflowRunArtifacts.mockImplementation(
      () => new Promise<{ artifacts: WorkflowRunArtifact[] }>((r) => (resolve = r)),
    );
    const view = renderCompletion(true);
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 … 个");
    resolve({ artifacts: journalArtifacts });
    await waitFor(() =>
      expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 6 个"),
    );
    cleanup();

    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const old = renderCompletion(true);
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(old.getByTestId("workflow-completion-more").textContent).toBe("还有 … 个");
  });

  it("冷渲染（没有会话上下文）只有载荷：省略号是诚实的", () => {
    hasConversation = false;
    const view = renderCompletion(true);
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 … 个");
    expect(workflowRunArtifacts).not.toHaveBeenCalled();
  });

  it("没砍过的载荷：数字从一开始就对，journal 补齐后也不变", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: journalArtifacts.slice(0, 8) });
    const view = renderCompletion(false);
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 2 个");
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalled());
    expect(view.getByTestId("workflow-completion-more").textContent).toBe("还有 2 个");
  });
});

// 打开请求（docs/dynamic-workflow/authoring.md「How the user sees them」）：宿主据 `contentType`
// 把 html 产物直接开成浏览器 tab，据 `sourcePath` 定位工作区里的原文件。卡上的清单有两份——
// 冷态只有通知载荷（没有出处），活路径下补齐过——请求必须跟着**当时画出来的那一份**走。
describe("ConversationWorkflowCompletion · 交付物行交出去的打开请求", () => {
  const PAYLOAD: WorkflowTurnCompletion["artifacts"] = [
    { id: "report", kind: "file", title: "审计报告", version: 1, primary: true },
  ];

  it("journal 补齐后带上 contentType 与 sourcePath（载荷两个都没有）", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        {
          id: "report",
          kind: "file",
          title: "审计报告",
          version: 1,
          contentType: "text/html",
          sourcePath: "reports/audit.html",
          versions: [{ version: 1, publishedAt: 1, bytes: 6, primary: true }],
          itemCount: 0,
          primary: true,
        },
      ],
    });
    const onOpenWorkflowArtifact = vi.fn();
    const view = renderCompletion(false, { artifacts: PAYLOAD, onOpenWorkflowArtifact });
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalled());

    fireEvent.click(view.getByTestId("workflow-completion-row"));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      runId: "dwfrun-1",
      artifactId: "report",
      title: "审计报告",
      contentType: "text/html",
      sourcePath: "reports/audit.html",
    });
  });

  it("冷渲染只有载荷：contentType 照载荷交出，出处不编造", () => {
    hasConversation = false;
    const onOpenWorkflowArtifact = vi.fn();
    const view = renderCompletion(false, {
      artifacts: [{ ...PAYLOAD[0]!, contentType: "text/html" }],
      onOpenWorkflowArtifact,
    });

    fireEvent.click(view.getByTestId("workflow-completion-row"));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      parentSessionId: "session-1",
      runId: "dwfrun-1",
      artifactId: "report",
      title: "审计报告",
      contentType: "text/html",
    });
  });
});
