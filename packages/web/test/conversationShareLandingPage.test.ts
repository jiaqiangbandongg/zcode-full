import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationSharePreview } from "@zcode/shared";
import {
  ConversationShareLandingPage,
  ConversationShareLandingStatus,
} from "../src/share/ConversationShareLandingPage.js";

const preview: ConversationSharePreview = {
  schema_version: 1,
  share: {
    title: "公开任务",
    access_mode: "public_importable",
    created_at: 1_000,
    expires_at: 2_000,
  },
  rows: [
    {
      rowId: 1,
      turnId: "share-turn-1",
      productTurnId: "share-product-turn-1",
      createdAt: 1_000,
      createdAtSeq: 1,
      kind: "userInput",
      text: "请生成一个文件",
      origin: "realUser",
    },
    {
      rowId: 2,
      turnId: "share-turn-1",
      productTurnId: "share-product-turn-1",
      createdAt: 1_001,
      createdAtSeq: 2,
      kind: "assistantText",
      text: "已完成 **文件**",
      state: "complete",
    },
  ],
  artifacts: [],
  integrity: {
    projection_sha256: "a".repeat(64),
    artifact_set_sha256: "b".repeat(64),
  },
};

describe("ConversationShareLandingPage", () => {
  it("renders public content and only the importable deep link", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationShareLandingPage, {
        shareCode: "share-1",
        preview,
        locale: "zh-CN",
      }),
    );
    expect(html).toContain("公开任务");
    expect(html).toContain('data-share-header="true"');
    expect(html).toContain('data-share-header-shell="true"');
    expect(html).toContain('data-share-header-row="true"');
    expect(html).toContain('data-share-brand="true"');
    expect(html.match(/data-share-content-rail="true"/g)?.length).toBe(2);
    expect(html.match(/data-share-content-inset="true"/g)?.length).toBe(3);
    expect(html).toContain('data-share-body-rail="true"');
    expect(html).toContain('data-share-title="true"');
    expect(html).toContain('data-share-continue-slot="true"');
    expect(html).toContain('data-share-continue-visible="true"');
    expect(html).toContain('data-share-continue-measure="true"');
    expect(html).toContain('title="公开任务"');
    // 首屏（SSR/未测量）先保留自然排列，客户端测量后只写入连续几何变量；
    // 不再在 inline 与 rail-aligned 两种布局之间切换。
    expect(html).toContain('data-share-header-layout="continuous"');
    expect(html).toContain('data-share-header-ready="false"');
    expect(html).not.toContain('data-share-header-layout="compact"');
    expect(html).not.toContain("absolute inset-x-0 bottom-0");
    expect(html).toContain("bg-background backdrop-blur");
    expect(html).not.toContain("bg-background/95");
    expect(html).toContain("ZCode");
    expect(html).toContain("sticky");
    expect(html).toContain("text-left");
    expect(html).not.toContain("grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]");
    expect(html).toContain("max-w-4xl");
    expect(html).toContain("sm:px-8");
    expect(html).toContain("sm:py-10");
    expect(html).toContain("data-share-metadata");
    expect(html).toContain("请生成一个文件");
    expect(html).toContain("data-v4-user-input-bubble");
    expect(html).toContain("group/assistant-row");
    expect(html).toContain('data-share-scroll-viewport="true"');
    expect(html).toContain('data-markdown-table-layout-root="true"');
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("去 ZCode 继续");
    expect(html).toContain('data-share-theme-toggle="true"');
    expect(html).toContain("切换到深色主题");
    expect(html.match(/data-share-continue-link="true"/g)?.length).toBe(2);
    expect(html).toContain('data-share-continue-footer="true"');
    expect(html.match(/href="zcode:\/\/share\/import\?code=share-1"/g)?.length).toBe(2);
    expect(html.indexOf('data-share-continue-footer="true"')).toBeGreaterThan(
      html.indexOf("data-conversation-share-timeline"),
    );
    expect(html).toContain("rounded-xl");
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
    expect(html).not.toContain("ZCode 会话分享");
    expect(html).not.toContain("data-share-flag");
    expect(html).not.toContain("下载 ZCode");
    expect(html).not.toContain("Sign out");
    expect(html).toContain("zcode://share/import?code=share-1");
  });

  it("counts only artifact rows and excludes user input attachment manifests", () => {
    const inputRef = "zcode-artifact://share/input-1";
    const resultRef = "zcode-artifact://share/result-1";
    const mixedPreview: ConversationSharePreview = {
      ...preview,
      rows: [
        {
          ...preview.rows[0]!,
          kind: "userInput",
          attachments: [
            {
              ref: inputRef,
              previewRef: inputRef,
              fileName: "pasted-text.txt",
              mime: "text/plain",
              bytes: 16_384,
            },
          ],
        },
        preview.rows[1]!,
        {
          rowId: 3,
          turnId: "share-turn-1",
          productTurnId: "share-product-turn-1",
          createdAt: 1_002,
          createdAtSeq: 3,
          kind: "artifact",
          artifactVersionId: "result-1",
          logicalArtifactKey: "result-key-1",
          displayName: "report.pdf",
          artifactType: "pdf",
          mimeType: "application/pdf",
          sizeBytes: 32_768,
          sha256: "c".repeat(64),
          ref: resultRef,
          state: "current",
        },
      ],
      artifacts: [
        {
          artifact_id: "input-1",
          logical_artifact_key: "input-key-1",
          producer_product_turn_id: "share-product-turn-1",
          artifact_version: 1,
          state: "current",
          ref: inputRef,
          artifact_type: "text",
          display_name: "pasted-text.txt",
          extension: "txt",
          mime_type: "text/plain",
          size_bytes: 16_384,
          sha256: "b".repeat(64),
          url: "https://example.test/input-1",
          url_expires_at: 2_000,
        },
        {
          artifact_id: "result-1",
          logical_artifact_key: "result-key-1",
          producer_product_turn_id: "share-product-turn-1",
          artifact_version: 1,
          state: "current",
          ref: resultRef,
          artifact_type: "pdf",
          display_name: "report.pdf",
          extension: "pdf",
          mime_type: "application/pdf",
          size_bytes: 32_768,
          sha256: "c".repeat(64),
          url: "https://example.test/result-1",
          url_expires_at: 2_000,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(ConversationShareLandingPage, {
        shareCode: "share-1",
        preview: mixedPreview,
        locale: "zh-CN",
      }),
    );
    expect(html).toContain("1 个结果物");
    expect(html).not.toContain("2 个结果物");
    expect(html).toContain("pasted-text.txt");
    expect(html).toContain("report.pdf");
  });

  it("does not show a result count when the share contains only input attachments", () => {
    const inputOnly = {
      ...preview,
      rows: [
        {
          ...preview.rows[0]!,
          kind: "userInput" as const,
          attachments: [
            {
              ref: "zcode-artifact://share/input-only",
              fileName: "input.txt",
              mime: "text/plain",
              bytes: 5,
            },
          ],
        },
        preview.rows[1]!,
      ],
      artifacts: [
        {
          artifact_id: "input-only",
          logical_artifact_key: "input-only-key",
          producer_product_turn_id: "share-product-turn-1",
          artifact_version: 1 as const,
          state: "current" as const,
          ref: "zcode-artifact://share/input-only",
          artifact_type: "text" as const,
          display_name: "input.txt",
          extension: "txt",
          mime_type: "text/plain",
          size_bytes: 5,
          sha256: "d".repeat(64),
          url: "https://example.test/input-only",
          url_expires_at: 2_000,
        },
      ],
    } satisfies ConversationSharePreview;
    const html = renderToStaticMarkup(
      createElement(ConversationShareLandingPage, {
        shareCode: "share-1",
        preview: inputOnly,
        locale: "zh-CN",
      }),
    );
    expect(html).not.toContain("个结果物");
  });

  it("does not offer continuation for readonly shares", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationShareLandingPage, {
        shareCode: "share-1",
        preview: { ...preview, share: { ...preview.share, access_mode: "public_readonly" } },
        locale: "en-US",
      }),
    );
    expect(html).not.toContain("zcode://share/import");
    expect(html).not.toContain("Open in ZCode");
    expect(html).not.toContain("去 ZCode 继续");
    expect(html).toContain('data-share-theme-toggle="true"');
    expect(html).not.toContain('data-share-continue-footer="true"');
    expect(html).toContain('data-share-continue-measure="true"');
    expect(html).toContain('data-share-continue-visible="false"');
  });

  it("renders private login-required status without exposing API details", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationShareLandingStatus, {
        state: { kind: "login_required" },
        locale: "en-US",
      }),
    );
    expect(html).toContain("Sign in to view this share");
    expect(html).not.toContain("3211");
  });

  it.each([
    ["zh-CN", "账号数据不互通", "回到首页"],
    ["en-US", "do not share account data", "Back to home"],
  ] as const)(
    "offers account guidance and home navigation for not_found in %s",
    (locale, hint, home) => {
      const html = renderToStaticMarkup(
        createElement(ConversationShareLandingStatus, {
          state: { kind: "error", error: "not_found" },
          locale,
          onRetry: () => {},
        }),
      );
      expect(html).toContain(hint);
      expect(html).toContain(home);
      expect(html).toContain('href="https://zcode.z.ai"');
      expect(html).not.toContain('target="_blank"');
    },
  );

  it.each([
    "network",
    "expired",
    "authentication_required",
    "invalid_contract",
    "unsupported_schema_version",
    "rate_limited",
    "unknown",
  ] as const)("keeps account guidance and home navigation out of %s", (error) => {
    const html = renderToStaticMarkup(
      createElement(ConversationShareLandingStatus, {
        state: { kind: "error", error },
        locale: "zh-CN",
        onRetry: () => {},
      }),
    );
    expect(html).not.toContain("账号数据不互通");
    expect(html).not.toContain("回到首页");
  });
});
