import type { Hook, WorkspaceHookReviewTrustState } from "@zcode/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  hasWorkspaceHooksRequiringReview,
  requiresWorkspaceHookTrust,
  shouldShowWorkspaceHookTrustNotice,
  WorkspaceHookTrustNotice,
} from "@/settings/WorkspaceHookTrustNotice.js";

function workspaceHook(trustState: WorkspaceHookReviewTrustState): Hook {
  return {
    id: `workspace-${trustState}`,
    event: "PreToolUse",
    type: "command",
    command: "echo review",
    enabled: true,
    editable: false,
    location: {
      source: "zcode",
      scope: "project",
      directoryPath: "/workspace/.zcode",
      projectPath: "/workspace",
    },
    workspaceHook: {
      sourceRootEnabled: true,
      declarationEnabled: true,
      runtimeHooksEnabled: true,
      configuredEnabled: true,
      sourcePath: "/workspace/.zcode/config.json",
      reviewItemId: `review-${trustState}`,
      workspaceIdentity: "/workspace",
      bundleDigest: "a".repeat(64),
      hookDeclarationDigest: "b".repeat(64),
      sourceFileIndex: 0,
      trustState,
    },
  };
}

function renderNotice(locale: "en-US" | "zh-CN", hooks: Hook[]): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkspaceHookTrustNotice, { hooks }),
    ),
  );
}

describe("Workspace Hook Trust settings notice", () => {
  it("shows a non-interactive warning for hooks that still expose the inline Trust action", () => {
    const hooks = [workspaceHook("pending_trust")];
    const html = renderNotice("en-US", hooks);

    expect(hasWorkspaceHooksRequiringReview(hooks)).toBe(true);
    expect(html).toContain('role="note"');
    expect(html).toContain('data-testid="workspace-hook-trust-notice"');
    expect(html).toContain("Hooks can run outside of the sandbox");
    expect(html).toContain("border-warning/30 bg-warning/10");
    expect(html).toContain("lucide-circle-alert");
    expect(html).not.toContain("<button");
  });

  it("uses the requested Chinese copy", () => {
    expect(renderNotice("zh-CN", [workspaceHook("stale_digest")])).toContain(
      "钩子可在沙盒外运行，因此，请审查最近安装或修改的所有钩子",
    );
  });

  it("hides after every Workspace Hook is persistently trusted", () => {
    const hooks = [workspaceHook("trusted_persistent")];

    expect(hasWorkspaceHooksRequiringReview(hooks)).toBe(false);
    expect(renderNotice("en-US", hooks)).toBe("");
  });

  it("ignores ordinary user hooks without Workspace Hook Trust metadata", () => {
    const hook = workspaceHook("pending_trust");
    delete hook.workspaceHook;

    expect(hasWorkspaceHooksRequiringReview([hook])).toBe(false);
    expect(renderNotice("en-US", [hook])).toBe("");
  });

  it("keeps the notice hidden while the target workspace is connecting", () => {
    const workspaceAHooks = [workspaceHook("pending_trust")];

    expect(
      shouldShowWorkspaceHookTrustNotice({
        hooks: workspaceAHooks,
        loadedWorkspaceKey: "workspace-a",
        rpcReady: false,
        targetWorkspaceKey: "workspace-b",
      }),
    ).toBe(false);
    expect(
      shouldShowWorkspaceHookTrustNotice({
        hooks: workspaceAHooks,
        loadedWorkspaceKey: "workspace-a",
        rpcReady: true,
        targetWorkspaceKey: "workspace-b",
      }),
    ).toBe(false);
  });

  it("shows only the loaded target snapshot, even when search filters every row", () => {
    const workspaceBHooks = [workspaceHook("pending_trust")];

    expect(
      shouldShowWorkspaceHookTrustNotice({
        hooks: workspaceBHooks,
        loadedWorkspaceKey: "workspace-b",
        rpcReady: true,
        targetWorkspaceKey: "workspace-b",
      }),
    ).toBe(true);
    expect(renderNotice("en-US", workspaceBHooks)).toContain(
      'data-testid="workspace-hook-trust-notice"',
    );
  });

  it("reuses the single-hook trust predicate for scope and row decisions", () => {
    for (const trustState of ["pending_trust", "stale_digest", "trusted_persistent"] as const) {
      const hook = workspaceHook(trustState);
      expect(hasWorkspaceHooksRequiringReview([hook])).toBe(requiresWorkspaceHookTrust(hook));
    }
  });
});
