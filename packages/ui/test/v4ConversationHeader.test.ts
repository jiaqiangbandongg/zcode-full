import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TID_V4_PANE_WORKSPACE_BADGE,
  TID_V4_SPLIT_CLOSE,
  TID_V4_SPLIT_DOWN,
  TID_V4_SPLIT_OPEN,
} from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationHeader } from "@/v4/ConversationHeader.js";

function renderHeader(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationHeader, {
        title: "这是个啥项目",
        onClosePane: vi.fn(),
        workspaceBadge: {
          label: "workspace",
          workspacePath: "/tmp/workspace",
          remote: false,
        },
        ...overrides,
      }),
    ),
  );
}

describe("ConversationHeader pane chrome", () => {
  it("renders no split controls while keeping the other floating pane actions", () => {
    const html = renderHeader();

    expect(html).toContain('data-v4-pane-actions="floating"');
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_OPEN}"`);
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_DOWN}"`);
    expect(html).toContain(`data-testid="${TID_V4_SPLIT_CLOSE}"`);
    expect(html).toContain(`data-testid="${TID_V4_PANE_WORKSPACE_BADGE}"`);
  });

  it("does not render an empty floating action group without pane actions", () => {
    const html = renderHeader({ workspaceBadge: undefined, onClosePane: undefined });

    expect(html).not.toContain('data-v4-pane-actions="floating"');
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_OPEN}"`);
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_DOWN}"`);
  });
});
