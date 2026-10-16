import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubagentDirectorySidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/hooks/useSessionSubagents.js", () => ({
  useSessionSubagents: () => ({
    error: null,
    loading: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    revision: 2,
    ended: {
      total: 21,
      nextCursor: "cursor",
      items: [
        {
          childSessionId: "child-failed",
          subagentType: "general-purpose",
          title: "Run verification",
          summary: "Provider request failed",
          status: "failed",
          endedAt: Date.now() - 60_000,
        },
      ],
    },
  }),
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => ({
    layer: { acquire: vi.fn(() => ({ release: vi.fn() })) },
  }),
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({
    snapshot: {
      subagents: {
        revision: 2,
        childSessionIds: ["child-running", "child-failed"],
        running: [
          {
            childSessionId: "child-running",
            subagentType: "Explore",
            title: "Inspect source tree",
            status: "blocked",
            startedAt: Date.now() - 5_000,
          },
        ],
        endedTotal: 21,
      },
    },
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, string>) =>
        values ? `${descriptor.id}:${Object.values(values).join("/")}` : descriptor.id,
    },
  }),
}));

const tab: SubagentDirectorySidePaneTab = {
  id: "subagent-directory:workspace:root:parent",
  type: "subagent-directory",
  workspaceKey: "ssh://host/workspace",
  workspacePath: "/workspace",
  workspaceIdentity: "ssh://host/workspace",
  remoteSessionId: "remote-session",
  rootSessionId: "root-session",
  parentSessionId: "parent-session",
};

describe("SubagentDirectorySidePane", () => {
  it("renders unpaged running and paged ended sections with status and summary", async () => {
    const { SubagentDirectorySidePane } = await import("@/app-shell/SubagentDirectorySidePane.js");
    const html = renderToStaticMarkup(
      createElement(SubagentDirectorySidePane, {
        tab,
        onOpenSubagentSession: vi.fn(),
      }),
    );

    expect(html).toContain("subagentDirectory.running · 1");
    expect(html).toContain("subagentDirectory.ended · 21");
    expect(html).toContain("Inspect source tree");
    expect(html).toContain("subagentDirectory.status.blocked");
    expect(html).toContain("Provider request failed");
    expect(html).toContain("subagentDirectory.status.failed");
    expect(html).toContain("subagentDirectory.showMore");
  });

  it("builds a scoped detail request that preserves remote workspace identity", async () => {
    const { buildSubagentDirectoryOpenRequest } =
      await import("@/app-shell/SubagentDirectorySidePane.js");
    expect(
      buildSubagentDirectoryOpenRequest(tab, {
        childSessionId: "child-failed",
        subagentType: "Explore",
        title: "Inspect source tree",
        status: "failed",
      }),
    ).toEqual({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-session",
      rootSessionId: "root-session",
      parentSessionId: "parent-session",
      childSessionId: "child-failed",
      subagentType: "Explore",
      title: "Inspect source tree",
    });
  });
});
