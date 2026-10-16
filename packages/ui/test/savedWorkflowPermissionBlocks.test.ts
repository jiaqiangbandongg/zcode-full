// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 与 workflowPermissionBlock.test.ts 同一组桩：CodeBlock 换成可断言的 <pre>。时间线是纯 DOM，
// 不需要桩。
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { PermissionDialog } from "@/PermissionDialog.js";

const SCRIPT =
  'const x = 1;\nconst r = await agent("a").ask<string>("检查 " + String(args.target));';
const SAVED_PATH = "/workspace/.zcode/workflows/release-check.dwf.ts";
// CLI 侧的 ask reason 是协议诊断文案，两个确认窗都必须不展示它。
const SAVE_CLI_REASON = "saveWorkflow.confirmation: user must confirm writing the workflow file";

const CAUSALITY_GRAPH = {
  steps: [
    {
      id: "ask#1",
      kind: "ask" as const,
      label: "a",
      line: 2,
      column: 21,
      lane: "actor#1",
    },
  ],
  lanes: [{ id: "actor#1", name: "a", line: 2, column: 11 }],
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
  sink: ["ask#1"],
};

const STANDARD_OPTIONS = [
  { optionId: "allowOnce", kind: "allowOnce", name: "Allow", response: { decision: "allow" } },
  { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
];

function buildRunRequest(overrides: Partial<ZCodePermissionRequest> = {}): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-run",
    description: "createWorkflow.runConfirmation: user must confirm running the analyzed script",
    kind: "CreateWorkflow",
    title: "CreateWorkflow",
    options: STANDARD_OPTIONS,
    display: {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: CAUSALITY_GRAPH,
    },
    raw: { name: "Release check", script: SCRIPT },
    ...overrides,
  } as ZCodePermissionRequest;
}

/** saved 源启动：归一化入参在 `script` 之外多一个 `saved`，display 形状一个字节没变。 */
function buildSavedRunRequest(saved: Record<string, unknown> = {}): ZCodePermissionRequest {
  return buildRunRequest({
    raw: {
      name: "Release check",
      script: SCRIPT,
      saved: {
        name: "release-check",
        path: SAVED_PATH,
        scope: "project",
        args: { target: "packages/ui", skipTests: false },
        ...saved,
      },
    },
  });
}

function buildSaveRequest(overrides: Record<string, unknown> = {}): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-save",
    description: SAVE_CLI_REASON,
    kind: "SaveWorkflow",
    title: "SaveWorkflow",
    options: STANDARD_OPTIONS,
    // spec：这个 gate 没有 display 载荷，入参就是全部内容。
    raw: {
      name: "release-check",
      description: "对本仓库做一次发布前检查",
      whenToUse: "用户说要发版时",
      args: {
        target: { type: "string", required: true, description: "要检查的包名或路径" },
        skipTests: { type: "boolean", default: false },
      },
      script: SCRIPT,
      path: SAVED_PATH,
      overwrite: false,
      scope: "project",
      ...overrides,
    },
  } as ZCodePermissionRequest;
}

function renderDialog(
  request: ZCodePermissionRequest,
  locale: "en-US" | "zh-CN" = "en-US",
  onRespond: (requestId: string, option: unknown) => void = () => {},
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(PermissionDialog, { request, onRespond, workspacePath: "/workspace" }),
    ),
  );
}

afterEach(cleanup);

// ── 运行确认窗的 saved 来源徽标 ──

describe("WorkflowPermissionBlock saved source badge", () => {
  it("renders provenance and arguments from raw.saved", () => {
    renderDialog(buildSavedRunRequest());

    const badge = document.querySelector('[data-workflow-saved-source="true"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain("Saved workflow · project");
    expect(document.querySelector('[data-workflow-saved-name="true"]')?.textContent).toBe(
      "release-check",
    );
    expect(document.querySelector('[data-workflow-saved-path="true"]')?.textContent).toBe(
      SAVED_PATH,
    );

    // 实参逐条可读；布尔值走 JSON，字符串原样（引号只会给中文实参添噪）。
    const args = document.querySelector('[data-workflow-saved-args="true"]');
    expect(args?.textContent).toContain("target");
    expect(args?.textContent).toContain("packages/ui");
    expect(args?.textContent).toContain("skipTests");
    expect(args?.textContent).toContain("false");
  });

  it("is absent for an inline run", () => {
    renderDialog(buildRunRequest());

    expect(document.querySelector('[data-workflow-saved-source="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Saved workflow");
  });

  it("does not displace the graph, and sits above it", () => {
    renderDialog(buildSavedRunRequest());

    // 时间线仍是决策主体：徽标只占一行，时间线照常渲染，脚本照常默认收起。
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.queryByTestId("code-block")).toBeNull();

    const block = document.querySelector('[data-workflow-permission-block="true"]');
    const badge = document.querySelector('[data-workflow-saved-source="true"]');
    const graph = screen.getByTestId("workflow-timeline");
    expect(block?.contains(badge ?? null)).toBe(true);
    // compareDocumentPosition: FOLLOWING(4) 表示 graph 在 badge 之后。
    expect((badge?.compareDocumentPosition(graph) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("still renders without an args table when the argument bag is empty", () => {
    renderDialog(buildSavedRunRequest({ args: {} }));

    expect(document.querySelector('[data-workflow-saved-source="true"]')).toBeTruthy();
    expect(document.querySelector('[data-workflow-saved-args="true"]')).toBeNull();
  });

  it("drops the badge when the saved payload has no name to stand on", () => {
    renderDialog(buildSavedRunRequest({ name: "   " }));

    expect(document.querySelector('[data-workflow-saved-source="true"]')).toBeNull();
    // 徽标缺席不影响这次运行的决策主体。
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
  });

  it("renders the badge in both locales", () => {
    renderDialog(buildSavedRunRequest(), "zh-CN");
    expect(document.querySelector('[data-workflow-saved-source="true"]')?.textContent).toContain(
      "已保存的工作流 · project",
    );
    cleanup();

    renderDialog(buildSavedRunRequest(), "en-US");
    expect(document.querySelector('[data-workflow-saved-source="true"]')?.textContent).toContain(
      "Saved workflow · project",
    );
  });
});

// ── 保存确认窗 ──

describe("SaveWorkflowPermissionBlock", () => {
  it("renders the save gate instead of the fallback JSON dump", () => {
    renderDialog(buildSaveRequest());

    expect(document.querySelector('[data-save-workflow-permission-block="true"]')).toBeTruthy();
    // 通用兜底会把整包 toolCall JSON 摊开；富确认块必须把它挡掉。
    expect(document.body.textContent).not.toContain('"script"');
    expect(document.body.textContent).not.toContain("toolName");
    // 运行确认窗的图与 Refine 都不属于一次写盘。
    expect(document.querySelector('[data-workflow-permission-block="true"]')).toBeNull();
    expect(screen.queryByTestId("workflow-causality-graph")).toBeNull();
  });

  it("suppresses the diagnostic CLI reason", () => {
    renderDialog(buildSaveRequest());

    expect(document.body.textContent).not.toContain(SAVE_CLI_REASON);
    expect(document.body.textContent).not.toContain("saveWorkflow.confirmation");
  });

  it("shows name, path, description and whenToUse", () => {
    renderDialog(buildSaveRequest());

    expect(screen.getByText("Save this workflow to the project?")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(screen.getByText(SAVED_PATH)).toBeTruthy();
    expect(screen.getByText("对本仓库做一次发布前检查")).toBeTruthy();
    expect(screen.getByText("用户说要发版时")).toBeTruthy();
  });

  it("renders the args declaration table with type, required and default", () => {
    renderDialog(buildSaveRequest());

    const table = document.querySelector('[data-workflow-save-args="true"]');
    expect(table).toBeTruthy();

    const target = document.querySelector('[data-workflow-save-arg="target"]');
    expect(target?.textContent).toContain("target");
    expect(target?.textContent).toContain("string");
    expect(target?.textContent).toContain("Required");
    expect(table?.textContent).toContain("要检查的包名或路径");

    const skipTests = document.querySelector('[data-workflow-save-arg="skipTests"]');
    expect(skipTests?.textContent).toContain("boolean");
    expect(skipTests?.textContent).toContain("Optional");
    // `default: false` 与「没有默认值」必须可分辨。
    expect(skipTests?.textContent).toContain("false");
  });

  it("keeps the script collapsed by default and opens it on demand", () => {
    renderDialog(buildSaveRequest());

    expect(screen.queryByTestId("code-block")).toBeNull();
    expect(document.body.textContent).not.toContain('await agent("a")');

    fireEvent.click(screen.getByText("Show full script"));

    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Hide full script")).toBeTruthy();
  });

  it("states overwrite as a different sentence, with an emphasised badge and hint", () => {
    renderDialog(buildSaveRequest({ overwrite: true }));

    expect(screen.getByText("Overwrite the existing saved workflow?")).toBeTruthy();
    expect(screen.queryByText("Save this workflow to the project?")).toBeNull();
    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')?.textContent).toBe(
      "overwrite",
    );
    expect(document.querySelector('[data-workflow-overwrite-hint="true"]')).toBeTruthy();
  });

  it("says nothing about overwriting on a fresh save", () => {
    renderDialog(buildSaveRequest());

    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')).toBeNull();
    expect(document.querySelector('[data-workflow-overwrite-hint="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Overwrite");
  });

  it("renders standard allow/deny only, with no refine machinery", () => {
    const onRespond = vi.fn();
    renderDialog(buildSaveRequest(), "en-US", onRespond);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(document.querySelector('[data-permission-feedback-option="workflowRefine"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Refine");

    // 既有语义：未选中的选项第一次点击只做选中，第二次点击才应答。
    const deny = screen.getByRole("option", { name: "Deny" });
    fireEvent.click(deny);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(deny);
    // 第三个参数是拒绝反馈文本；这里没有输入，应答明确带 undefined。
    expect(onRespond).toHaveBeenCalledWith(
      "perm-save",
      expect.objectContaining({ optionId: "deny" }),
      undefined,
    );
  });

  it("survives a payload that carries only a name", () => {
    renderDialog({
      ...buildSaveRequest(),
      raw: { name: "release-check" },
    } as ZCodePermissionRequest);

    expect(screen.getByText("Save this workflow to the project?")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(document.querySelector('[data-workflow-save-args="true"]')).toBeNull();
    expect(screen.queryByText("Show full script")).toBeNull();
  });

  it("renders both locales", () => {
    renderDialog(buildSaveRequest({ overwrite: true }), "zh-CN");
    expect(screen.getByText("覆盖已保存的同名工作流？")).toBeTruthy();
    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')?.textContent).toBe(
      "覆盖",
    );
    expect(screen.getByText("落点")).toBeTruthy();
    expect(screen.getByText("显示完整脚本")).toBeTruthy();
    cleanup();

    renderDialog(buildSaveRequest({ overwrite: true }), "en-US");
    expect(screen.getByText("Overwrite the existing saved workflow?")).toBeTruthy();
    expect(screen.getByText("Path")).toBeTruthy();
  });

  it("never paints the save gate with destructive colour", () => {
    // 覆盖是替换，不是删除：destructive 会过度表达。warning 才是这次操作的语义色。
    renderDialog(buildSaveRequest({ overwrite: true }));

    expect(document.body.innerHTML).not.toContain("text-destructive");
    expect(document.body.innerHTML).toContain("text-warning");
  });
});
