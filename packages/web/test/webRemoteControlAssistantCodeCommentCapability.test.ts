// @vitest-environment jsdom
import { createElement } from "react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
} from "@/lib/assistantCodeComment.js";

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("web remote control Assistant code-comment capability", () => {
  it("仅在两条承载 workspace 会话的 /remote bridge Root 上显式开启", async () => {
    const source = await readFile(resolve(process.cwd(), "packages/web/src/main.tsx"), "utf8");
    const externalRelayBridgeRoot = sliceBetween(
      source,
      "const renderExternalRelayRoot =",
      "const renderExternalRelayHomeOnlyRoot =",
    );
    const tokenBridgeRoot = sliceBetween(
      source,
      "const renderBridgeRoot =",
      "const openWorkspaceBridge =",
    );
    const externalRelayHomeOnlyRoot = sliceBetween(
      source,
      "const renderExternalRelayHomeOnlyRoot =",
      "bootstrapPairedSession =",
    );
    const ordinaryWebServerRoot = sliceBetween(
      source,
      'document.title = "ZCode - Web + Server";',
      "} catch (error) {",
    );

    expect(externalRelayBridgeRoot).toContain("assistantCodeCommentCardsEnabled");
    expect(tokenBridgeRoot).toContain("assistantCodeCommentCardsEnabled");
    expect(externalRelayHomeOnlyRoot).not.toContain("assistantCodeCommentCardsEnabled");
    expect(ordinaryWebServerRoot).not.toContain("assistantCodeCommentCardsEnabled");
    expect(source.match(/assistantCodeCommentCardsEnabled/g)).toHaveLength(2);
  });

  it("终态 replay row 通过共享投影隐藏 directive，并保留 remote review scope", () => {
    const assistantText =
      '已完成审查。\n::code-comment{title="[P1] 检查入口" body="请检查启动路径" file="src/main.ts" start=12 end=14 priority=1}';
    const workspacePath = "/remote/workspace";
    const workspaceIdentity = "remote:ssh:demo:/remote/workspace";
    const workspaceRemoteSessionId = "remote-session-1";
    const projection = projectAssistantCodeComments(assistantText, { streaming: false });
    const cards = buildAssistantCodeCommentCards(assistantText, workspacePath);
    const onOpenCodeViewer = vi.fn();

    expect(projection.visibleText).toBe("已完成审查。\n");
    expect(projection.visibleText).not.toContain("::code-comment");
    expect(cards).toHaveLength(1);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(AssistantCodeCommentCards, {
          cards,
          workspacePath,
          workspaceIdentity,
          workspaceRemoteSessionId,
          onOpenCodeViewer,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /展开 1 条评论/ }));
    fireEvent.click(screen.getByRole("button", { name: /检查入口/ }));

    expect(onOpenCodeViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "code-review",
        path: "/remote/workspace/src/main.ts",
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
        review: expect.objectContaining({
          title: "检查入口",
          body: "请检查启动路径",
          startLine: 12,
          endLine: 14,
        }),
      }),
    );
  });
});
