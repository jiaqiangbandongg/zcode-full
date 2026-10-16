// workflow 草稿免确认的判定，见 docs/dynamic-workflow/launch.md
// 「Script files」→「Editing a draft needs no approval」。
// 与 permission-service.test.ts 里 WebFetch 预批的用例同构：同一处决策位次，同一组边界
// （项目规则压得过、plan 压得过、没上下文就不生效）。

import { describe, expect, it, vi } from "vitest";
import { createSessionId, createToolCallId } from "@zcode/contracts";
import { createToolExecutor } from "../src/tool/executor.js";
import { recheckPermissionHookModifiedInput } from "../src/tool/executor/permission-input-recheck.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { createToolRegistry } from "../src/tool/registry.js";

import {
  PermissionService,
  type PermissionContext,
  type PermissionToolCapability,
} from "../src/permission/service.js";

const WORKING_DIRECTORY = "/ws/project";
const DRAFT_RELATIVE_PATH = ".zcode/workflow-drafts/report.dwf.ts";
const DRAFT_ABSOLUTE_PATH = "/ws/project/.zcode/workflow-drafts/report.dwf.ts";
const DRAFT_RULE_ID = "tool.workflowDraft.preapproved";

const editCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: true,
    permission: "edit",
    reason: "Edit modifies file contents",
    riskLevel: "medium",
    sideEffectScope: "workspace",
  },
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

const writeCapability: PermissionToolCapability = {
  ...editCapability,
  permission: {
    ...editCapability.permission!,
    reason: "Write creates or overwrites files",
  },
};

function draftContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    input: { file_path: DRAFT_RELATIVE_PATH },
    mode: "build",
    riskLevel: "medium",
    toolName: "Edit",
    workingDirectory: WORKING_DIRECTORY,
    ...overrides,
  };
}

describe("workflow draft preapproval", () => {
  it("preserves draft preapproval through the shared executor after merging Guarded", async () => {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register({
      ...writeToolEntry,
      handler,
      outputSchema: undefined,
      runtimeOutputSchema: undefined,
    });
    const requestPermission = vi.fn(async () => ({ decision: "deny" as const }));
    const service = new PermissionService();
    const checkPermission = vi.spyOn(service, "checkPermission");
    const executor = createToolExecutor({
      registry,
      mode: "build",
      workingDirectory: WORKING_DIRECTORY,
      sessionId: createSessionId("workflow-draft-merge"),
      emitEvent: async () => {},
      permissionService: service,
      permissionBroker: { requestPermission },
    });
    const result = await executor.execute({
      id: createToolCallId("workflow-draft-write"),
      name: "Write",
      input: { file_path: DRAFT_RELATIVE_PATH, content: "draft" },
    });
    expect(result.success).toBe(true);
    expect(checkPermission.mock.results[0]?.value.ruleId).toBe(DRAFT_RULE_ID);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rechecks rewritten draft input with the prepared cwd instead of the current cwd", () => {
    const service = new PermissionService();
    const checkPermission = vi.spyOn(service, "checkPermission");
    const input = { file_path: DRAFT_ABSOLUTE_PATH, content: "draft" };
    recheckPermissionHookModifiedInput({
      deps: {
        permissionService: service,
        getWorkingDirectory: () => "/ws/changed",
      } as never,
      entry: writeToolEntry,
      mode: "build",
      modifiedInput: input,
      projectRules: null,
      toolCall: { id: createToolCallId("workflow-draft-recheck"), name: "Write", input },
      context: {
        mode: "build",
        workingDirectory: WORKING_DIRECTORY,
        workspaceRoot: WORKING_DIRECTORY,
      },
    });
    expect(checkPermission.mock.results[0]?.value.ruleId).toBe(DRAFT_RULE_ID);
  });

  it("allows an Edit whose relative target resolves inside the drafts directory", () => {
    const decision = new PermissionService().checkPermission(draftContext(), editCapability, {
      version: 1,
    });

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      escalated: false,
      ruleId: DRAFT_RULE_ID,
    });
  });

  it("allows an Edit whose absolute target is inside the drafts directory", () => {
    const decision = new PermissionService().checkPermission(
      draftContext({ input: { file_path: DRAFT_ABSOLUTE_PATH } }),
      editCapability,
      { version: 1 },
    );

    expect(decision).toMatchObject({ allowed: true, decision: "allow", ruleId: DRAFT_RULE_ID });
  });

  it("allows a Write into the drafts directory", () => {
    const decision = new PermissionService().checkPermission(
      draftContext({ toolName: "Write" }),
      writeCapability,
      { version: 1 },
    );

    expect(decision).toMatchObject({ allowed: true, decision: "allow", ruleId: DRAFT_RULE_ID });
  });

  it("does not preapprove a target that escapes the drafts directory", () => {
    const decision = new PermissionService().checkPermission(
      draftContext({ input: { file_path: ".zcode/workflow-drafts/../../secrets.env" } }),
      editCapability,
      { version: 1 },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it("does not preapprove a sibling directory that merely shares the name prefix", () => {
    const decision = new PermissionService().checkPermission(
      draftContext({ input: { file_path: ".zcode/workflow-drafts-other/report.dwf.ts" } }),
      editCapability,
      { version: 1 },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it("does not preapprove a tool that carries no file_path", () => {
    const decision = new PermissionService().checkPermission(
      draftContext({
        input: { patch_text: `*** Update File: ${DRAFT_RELATIVE_PATH}` },
        toolName: "ApplyPatch",
      }),
      editCapability,
      { version: 1 },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it("falls through to the normal decision when the context carries no working directory", () => {
    const decision = new PermissionService().checkPermission(
      draftContext({ workingDirectory: undefined }),
      editCapability,
      { version: 1 },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it("still refuses a draft write in plan mode", () => {
    const decision = new PermissionService().checkPermission(
      draftContext({ mode: "plan" }),
      editCapability,
      { version: 1 },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });

  it("lets a project deny rule on Edit override the preapproval", () => {
    const decision = new PermissionService().checkPermission(draftContext(), editCapability, {
      version: 1,
      deny: [{ toolName: "Edit" }],
    });

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "rule.project.deny",
    });
  });

  it("lets a project ask rule on Edit override the preapproval", () => {
    const decision = new PermissionService().checkPermission(draftContext(), editCapability, {
      version: 1,
      ask: [{ toolName: "Edit" }],
    });

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "rule.project.ask",
    });
  });
});
