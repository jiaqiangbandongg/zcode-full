import { describe, expect, it } from "vitest";
import {
  resolveDraftWorkspacePrepareReason,
  shouldShowDraftWorkspacePrepareLoading,
} from "../src/lib/workspacePrepareReason.js";

describe("resolveDraftWorkspacePrepareReason", () => {
  it("首次进入草稿态时按 mount 处理", () => {
    expect(
      resolveDraftWorkspacePrepareReason({
        previousDraftProvider: null,
        previousTaskProvider: null,
        selectedProvider: "claude",
        returningFromTask: false,
      }),
    ).toBe("mount");
  });

  it("草稿态内切换 provider 时返回 select-provider", () => {
    expect(
      resolveDraftWorkspacePrepareReason({
        previousDraftProvider: "claude",
        previousTaskProvider: null,
        selectedProvider: "codex",
        returningFromTask: false,
      }),
    ).toBe("select-provider");
  });

  it("从 task 回到同 provider 草稿时不应误判为切换 provider", () => {
    expect(
      resolveDraftWorkspacePrepareReason({
        previousDraftProvider: "claude",
        previousTaskProvider: "claude",
        selectedProvider: "claude",
        returningFromTask: true,
      }),
    ).toBe("mount");
  });

  it("从 task 回到不同 provider 草稿时按 select-provider 处理，避免沿用旧 provider 的模型显示", () => {
    expect(
      resolveDraftWorkspacePrepareReason({
        previousDraftProvider: "claude",
        previousTaskProvider: "claude",
        selectedProvider: "opencode",
        returningFromTask: true,
      }),
    ).toBe("select-provider");
  });

  it("task 内先切新建 provider 后再进草稿时，按 task 原 provider 判定切换", () => {
    expect(
      resolveDraftWorkspacePrepareReason({
        previousDraftProvider: "codex",
        previousTaskProvider: "claude",
        selectedProvider: "codex",
        returningFromTask: true,
      }),
    ).toBe("select-provider");
  });
});

describe("shouldShowDraftWorkspacePrepareLoading", () => {
  it("首屏 mount 且尚未拿到配置快照时显示 loading", () => {
    expect(
      shouldShowDraftWorkspacePrepareLoading({
        taskId: null,
        reason: "mount",
        hasHydratedConfigOptions: false,
      }),
    ).toBe(true);
  });

  it("首屏 mount 但已有配置快照时不重复显示 loading", () => {
    expect(
      shouldShowDraftWorkspacePrepareLoading({
        taskId: null,
        reason: "mount",
        hasHydratedConfigOptions: true,
      }),
    ).toBe(false);
  });

  it("草稿态内切换 provider 时继续显示 loading", () => {
    expect(
      shouldShowDraftWorkspacePrepareLoading({
        taskId: null,
        reason: "select-provider",
        hasHydratedConfigOptions: true,
      }),
    ).toBe(true);
  });

  it("已有 task 时不走草稿 loading 逻辑", () => {
    expect(
      shouldShowDraftWorkspacePrepareLoading({
        taskId: "task-1",
        reason: "mount",
        hasHydratedConfigOptions: false,
      }),
    ).toBe(false);
  });
});
