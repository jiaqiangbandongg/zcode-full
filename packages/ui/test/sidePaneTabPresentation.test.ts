// 侧栏 tab 总览（SidePaneTabOverview）的展示三件套：搜索提示、本地化标题、类型标签。
// 新增 tab 类型漏掉这三处不会报错——getSidePaneTabTypeLabel 的兜底是 codeViewerTitle，
// 于是一个 workflow run tab 会在总览里被标成「代码预览」。所以三处各钉一条。
import { describe, expect, it } from "vitest";
import {
  getLocalizedSidePaneTabTitle,
  getSidePaneTabSearchHint,
  getSidePaneTabTypeLabel,
  type SidePaneTabPresentationLabels,
} from "@/app-shell/sidePaneTabPresentation.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

const labels: SidePaneTabPresentationLabels = {
  browserTitle: "Browser",
  reviewTitle: "Review",
  codeViewerTitle: "Code preview",
  treemappingTitle: "Treemapping",
  whiteboardTitle: "Whiteboard",
  modelTrajectoryTitle: "Model trajectory",
  developerToolsTitle: "Developer tools",
  terminalTitle: "Terminal",
  subagentTypeLabel: "Subagent",
  subagentDirectoryTitle: "Subagents",
  selectionChatTitle: "Auxiliary conversation",
  planTitle: "Plan",
  workflowRunTitle: "Workflow run",
  workflowActorTitle: "Workflow subagent",
  workflowArtifactTitle: "Artifact",
  workflowScriptTitle: "Script steps",
};

const workflowActorTab: Extract<WorkspaceSidePaneTab, { type: "workflow-actor-session" }> = {
  id: "workflow-actor-session:%2Fworkspace:parent-a:dwf-dwfrun-1-actor_1%401",
  type: "workflow-actor-session",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent-a",
  runId: "dwfrun-1",
  actorSessionId: "dwf-dwfrun-1-actor_1@1",
  siteId: "actor#1",
  ordinal: 2,
  actorName: "reviewer",
};

const workflowRunTab: Extract<WorkspaceSidePaneTab, { type: "workflow-run" }> = {
  id: "workflow-run:%2Fworkspace:parent-a:dwfrun-1",
  type: "workflow-run",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent-a",
  toolCallId: "tool-wf-1",
  runId: "dwfrun-1",
  workflowName: "Three-way review",
};

// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 交付给用户的产出（docs/dynamic-workflow/authoring.md
// 的「术语」表），不是引擎内部那个「脚本顶层返回值」的同名词。
const workflowArtifactTab: Extract<WorkspaceSidePaneTab, { type: "workflow-artifact" }> = {
  id: "workflow-artifact:%2Fworkspace:parent-a:dwfrun-1:book",
  type: "workflow-artifact",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent-a",
  runId: "dwfrun-1",
  artifactId: "book",
  title: "审计报告",
};

describe("workflow-run tab presentation", () => {
  it("makes the run searchable by run id, tool call id and parent session", () => {
    const hint = getSidePaneTabSearchHint(workflowRunTab);
    expect(hint).toContain("dwfrun-1");
    expect(hint).toContain("tool-wf-1");
    expect(hint).toContain("parent-a");
    expect(hint).toContain("Three-way review");
    expect(hint).toContain("workflow");
  });

  it("labels the type as a workflow run rather than falling through to code preview", () => {
    expect(getSidePaneTabTypeLabel(workflowRunTab, labels)).toBe("Workflow run");
    expect(getSidePaneTabTypeLabel(workflowRunTab, labels)).not.toBe(labels.codeViewerTitle);
  });

  it("localizes the generic title but keeps a captured workflow name verbatim", () => {
    expect(getLocalizedSidePaneTabTitle(workflowRunTab, labels)).toBe("Three-way review");
    const { workflowName: _dropped, ...unnamed } = workflowRunTab;
    expect(getLocalizedSidePaneTabTitle(unnamed, labels)).toBe("Workflow run");
  });
});

describe("workflow-actor-session tab presentation", () => {
  it("makes the actor searchable by run, site, ordinal and session id", () => {
    const hint = getSidePaneTabSearchHint(workflowActorTab);
    expect(hint).toContain("dwfrun-1");
    expect(hint).toContain("actor#1");
    expect(hint).toContain("dwf-dwfrun-1-actor_1@1");
    expect(hint).toContain("parent-a");
    expect(hint).toContain("reviewer");
    expect(hint).toContain("workflow subagent actor transcript");
  });

  it("labels the type as a workflow actor rather than falling through to code preview", () => {
    expect(getSidePaneTabTypeLabel(workflowActorTab, labels)).toBe("Workflow subagent");
    expect(getSidePaneTabTypeLabel(workflowActorTab, labels)).not.toBe(labels.codeViewerTitle);
    // 也不能被标成 subagent：actor 会话不是子智能体的子会话，两者的回收语义都不同。
    expect(getSidePaneTabTypeLabel(workflowActorTab, labels)).not.toBe(labels.subagentTypeLabel);
  });

  it("keeps the script-authored actor name verbatim and always carries the instance ordinal", () => {
    // 车道显示名的约定：脚本里写下的名字原样显示。序号必须在标题里——同一车道族的两个
    // 实例名字相同，少了序号 tab 条上就是两个无法区分的「reviewer」。
    expect(getLocalizedSidePaneTabTitle(workflowActorTab, labels)).toBe("reviewer #2");
    const { actorName: _dropped, ...unnamed } = workflowActorTab;
    expect(getLocalizedSidePaneTabTitle(unnamed, labels)).toBe("Workflow subagent #2");
  });
});

describe("workflow-artifact tab presentation", () => {
  it("makes the artifact searchable by its id, run and parent session", () => {
    const hint = getSidePaneTabSearchHint(workflowArtifactTab);
    // 产物 id 是脚本里写死的字面量，排查者手里往往就是它。
    expect(hint).toContain("book");
    expect(hint).toContain("dwfrun-1");
    expect(hint).toContain("parent-a");
    expect(hint).toContain("审计报告");
    expect(hint).toContain("workflow artifact deliverable");
  });

  it("labels the type as an artifact rather than falling through to code preview", () => {
    expect(getSidePaneTabTypeLabel(workflowArtifactTab, labels)).toBe("Artifact");
    expect(getSidePaneTabTypeLabel(workflowArtifactTab, labels)).not.toBe(labels.codeViewerTitle);
  });

  it("keeps the captured title verbatim, then the artifact id, then the generic label", () => {
    expect(getLocalizedSidePaneTabTitle(workflowArtifactTab, labels)).toBe("审计报告");
    const { title: _dropped, ...untitled } = workflowArtifactTab;
    // 展示名是打开时冻结的兜底；身份始终是 (runId, artifactId)，所以退回产物 id。
    expect(getLocalizedSidePaneTabTitle(untitled, labels)).toBe("book");
    expect(getLocalizedSidePaneTabTitle({ ...untitled, artifactId: "" }, labels)).toBe("Artifact");
  });
});

// 脚本 transcript（docs/dynamic-workflow/transcript-and-notifications.md「Opening the tab」）：与 actor transcript
// 同档的 run 内详情 tab；标题是 run 名，类型标签才说「Workflow workspace」。
describe("workflow-workspace tab presentation", () => {
  const workflowWorkspaceTab: Extract<WorkspaceSidePaneTab, { type: "workflow-workspace" }> = {
    id: "workflow-workspace:%2Fworkspace:parent-a:dwfrun-1",
    type: "workflow-workspace",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    parentSessionId: "parent-a",
    toolCallId: "tool-wf-1",
    runId: "dwfrun-1",
    workflowName: "Fan-out review",
  };

  it("makes the transcript searchable by run, tool call, parent session and the facade words", () => {
    const hint = getSidePaneTabSearchHint(workflowWorkspaceTab);
    expect(hint).toContain("dwfrun-1");
    expect(hint).toContain("tool-wf-1");
    expect(hint).toContain("parent-a");
    expect(hint).toContain("Fan-out review");
    expect(hint).toContain("workflow script steps workspace transcript files git run");
  });

  it("labels the type as a workflow workspace rather than falling through to code preview", () => {
    expect(getSidePaneTabTypeLabel(workflowWorkspaceTab, labels)).toBe("Script steps");
    expect(getSidePaneTabTypeLabel(workflowWorkspaceTab, labels)).not.toBe(labels.codeViewerTitle);
    expect(getSidePaneTabTypeLabel(workflowWorkspaceTab, labels)).not.toBe(labels.workflowRunTitle);
  });

  it("titles the tab with the run name and falls back to the generic label", () => {
    expect(getLocalizedSidePaneTabTitle(workflowWorkspaceTab, labels)).toBe("Fan-out review");
    const { workflowName: _dropped, ...unnamed } = workflowWorkspaceTab;
    expect(getLocalizedSidePaneTabTitle(unnamed, labels)).toBe("Script steps");
  });
});
