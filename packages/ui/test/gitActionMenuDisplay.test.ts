import { describe, expect, it } from "vitest";
import {
  canRenderGitActionMenu,
  canPushGitBranch,
  canUseGitActionMenu,
  resolveGitActionMenuPrimaryAction,
} from "../src/git-action-menu/display.js";

describe("canUseGitActionMenu", () => {
  it("keeps the entry rendered but disables actions when git is unavailable", () => {
    expect(
      canUseGitActionMenu({
        isGitAvailable: false,
        isRepository: false,
      }),
    ).toBe(false);

    expect(
      canUseGitActionMenu({
        isGitAvailable: true,
        isRepository: false,
      }),
    ).toBe(false);

    expect(
      canUseGitActionMenu({
        isGitAvailable: true,
        isRepository: true,
      }),
    ).toBe(true);
  });
});

describe("canRenderGitActionMenu", () => {
  it("renders only when commit or push is available", () => {
    expect(
      canRenderGitActionMenu({
        actionAvailable: true,
        commitEnabled: true,
        pushEnabled: false,
      }),
    ).toBe(true);

    expect(
      canRenderGitActionMenu({
        actionAvailable: true,
        commitEnabled: false,
        pushEnabled: true,
      }),
    ).toBe(true);

    expect(
      canRenderGitActionMenu({
        actionAvailable: true,
        commitEnabled: false,
        pushEnabled: false,
      }),
    ).toBe(false);
  });

  it("hides when git actions are unavailable", () => {
    expect(
      canRenderGitActionMenu({
        actionAvailable: false,
        commitEnabled: true,
        pushEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("canPushGitBranch", () => {
  it("requires a branch checkout before pushing", () => {
    expect(
      canPushGitBranch({
        headRefType: "detached",
        branchName: "main",
        trackingBranchName: "origin/main",
        ahead: 2,
      }),
    ).toBe(false);
  });

  it("allows first push without an upstream and hides redundant tracked no-op pushes", () => {
    expect(
      canPushGitBranch({
        headRefType: "branch",
        branchName: "feature/publish",
        trackingBranchName: null,
        ahead: 0,
      }),
    ).toBe(true);

    expect(
      canPushGitBranch({
        headRefType: "branch",
        branchName: "main",
        trackingBranchName: "origin/main",
        ahead: 0,
      }),
    ).toBe(false);
  });
});

describe("resolveGitActionMenuPrimaryAction", () => {
  it("prefers commit, then push", () => {
    expect(
      resolveGitActionMenuPrimaryAction({
        actionAvailable: true,
        commitEnabled: true,
        pushEnabled: true,
      }),
    ).toBe("commit");

    expect(
      resolveGitActionMenuPrimaryAction({
        actionAvailable: true,
        commitEnabled: false,
        pushEnabled: true,
      }),
    ).toBe("push");

    expect(
      resolveGitActionMenuPrimaryAction({
        actionAvailable: true,
        commitEnabled: false,
        pushEnabled: false,
      }),
    ).toBeNull();
  });

  it("has no primary action when git actions are unavailable", () => {
    expect(
      resolveGitActionMenuPrimaryAction({
        actionAvailable: false,
        commitEnabled: false,
        pushEnabled: false,
      }),
    ).toBeNull();
  });
});
