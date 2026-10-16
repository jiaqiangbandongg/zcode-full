import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";

function render(entry: PendingCommandEntry): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(PendingCommandRecoveryBanner, {
        entry,
        onResend: entry.replay.kind === "input" ? vi.fn() : undefined,
        onDismiss: vi.fn(),
      }),
    ),
  );
}

describe("PendingCommandRecoveryBanner", () => {
  it("discarded 普通输入提供显式重新发送按钮", () => {
    const html = render({
      commandId: "command-1",
      clientId: "client-1",
      sessionId: "session-1",
      issuedAt: 1,
      expiresAt: 2,
      recovery: "discarded",
      replay: { kind: "input", type: "sendText", payload: { text: "hello" } },
    });
    expect(html).toContain("CLI 重启前已提交的输入没有进入对话");
    expect(html).toContain("重新发送");
    expect(html).toContain("mb-3");
    expect(html).toContain("w-full");
    expect(html).toContain("shrink-0");
    expect(html).toContain("flex-wrap");
    expect(html).toContain("gap-2");
    expect(html).toContain("rounded-xl");
    expect(html).toContain("border-border");
    expect(html).toContain("bg-surface");
    expect(html).toContain("text-foreground");
    expect(html).not.toContain("bg-warning");
    expect(html).not.toContain("border-warning");
    expect(html).not.toContain("shadow-md");
  });
});
