import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createTurnId,
} from "@zcode/contracts";
import { MemoryFileSystem } from "./memory-test-utils.js";
import {
  formatPlanFileReference,
  readApprovedPlanFileReferenceEntry,
  resolveApprovedPlanFilePath,
  writeApprovedPlanFile,
} from "../src/runtime/helpers/plan-file-continuity.js";

describe("plan file continuity", () => {
  it("resolves approved plan file under workspace root with sanitized session id", () => {
    const path = resolveApprovedPlanFilePath({
      sessionId: "session:with/slashes",
      workspaceRoot: "/workspace/project",
    });

    expect(path.replace(/\\/g, "/")).toBe(
      "/workspace/project/.zcode/plans/plan-session-with-slashes.md",
    );
  });

  it("writes the approved plan byte-for-byte through FileSystemPort using the deterministic path", async () => {
    const fileSystemPort = new MemoryFileSystem({});
    const sessionId = createSessionId("plan-file-write");
    const traceContext = createRootTraceContext({
      sessionId,
      turnId: createTurnId("turn-plan-file-write"),
    });
    const approvedPlan = "\n  1. Read current code\n2. Add compact reminder\n\n";

    const result = await writeApprovedPlanFile({
      fileSystemPort,
      plan: approvedPlan,
      sessionId,
      traceContext,
      workspaceRoot: "/workspace/project",
    });

    expect(result.path.replace(/\\/g, "/")).toBe(
      "/workspace/project/.zcode/plans/plan-sess_plan-file-write.md",
    );
    expect(fileSystemPort.files[result.path]).toBe(approvedPlan);
  });

  it("formats the plan_file_reference reminder body", () => {
    expect(
      formatPlanFileReference({
        planContent: "1. Keep the approved plan\n2. Verify after compact",
        planFilePath: "/workspace/project/.zcode/plans/plan-session.md",
      }),
    ).toBe(
      [
        "A plan file exists from plan mode at: /workspace/project/.zcode/plans/plan-session.md",
        "",
        "Plan contents:",
        "",
        "1. Keep the approved plan\n2. Verify after compact",
        "",
        "If this plan is relevant to the current work and not already complete, continue working on it.",
      ].join("\n"),
    );
  });

  it("returns a model-only plan_file_reference entry when the plan file exists", async () => {
    const sessionId = createSessionId("plan-file-reference");
    const fileSystemPort = new MemoryFileSystem({
      "/workspace/project/.zcode/plans/plan-sess_plan-file-reference.md":
        "1. Preserve plan marker E2E_PLAN_FILE_CONTINUITY",
    });

    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort,
      sessionId,
      workspaceRoot: "/workspace/project",
    });

    expect(entry).toMatchObject({
      content: expect.stringContaining("A plan file exists from plan mode at:"),
      metadata: { source: "plan_file_reference" },
    });
    expect(entry?.content).toContain("Plan contents:");
    expect(entry?.content).toContain("E2E_PLAN_FILE_CONTINUITY");
    expect(entry?.content).toContain(
      "If this plan is relevant to the current work and not already complete, continue working on it.",
    );
  });

  it("returns undefined when the deterministic plan file does not exist", async () => {
    const entry = await readApprovedPlanFileReferenceEntry({
      fileSystemPort: new MemoryFileSystem({}),
      sessionId: createSessionId("no-plan-file"),
      workspaceRoot: "/workspace/project",
    });

    expect(entry).toBeUndefined();
  });
});
