import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  resolveClaudeMigrationScanLimit,
  UNLIMITED_SCAN_LIMIT_INPUT,
} from "@/hooks/useClaudeSessionMigration.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
        if (id === "onboarding.sessions.count") {
          return `${values?.count ?? ""} 个会话`;
        }
        if (id === "onboarding.sessions.unlimited") {
          return "不限制";
        }
        return id;
      },
    },
  }),
}));

vi.mock("@/components/ui/select.js", () => ({
  Select: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectContent: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectItem: ({ children, value }: { children: unknown; value: string }) =>
    createElement("div", { "data-value": value }, children),
  SelectTrigger: ({ children }: { children: unknown }) => createElement("button", null, children),
  SelectValue: () => null,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/badge.js", () => ({
  Badge: ({ children }: { children: unknown }) => createElement("span", null, children),
}));

describe("OnboardingSessionsStep", () => {
  it("把不限制选项解析为无扫描 limit", () => {
    expect(resolveClaudeMigrationScanLimit(UNLIMITED_SCAN_LIMIT_INPUT)).toBeUndefined();
  });

  it("提供 30、50、100 和不限制四个会话扫描数量选项", async () => {
    const { OnboardingSessionsStep } = await import("@/onboarding/OnboardingFlowParts.js");
    const html = renderToStaticMarkup(
      createElement(OnboardingSessionsStep, {
        migration: {
          range: "30d",
          setRange: vi.fn(),
          limitInput: "100",
          setLimitInput: vi.fn(),
          supportState: { supported: true },
          isScanning: false,
          scan: vi.fn(),
          scanError: null,
        },
        workspaceCandidates: [],
        selectedWorkspacePaths: [],
        onToggleWorkspace: vi.fn(),
        onSelectAll: vi.fn(),
        onClearSelection: vi.fn(),
      }),
    );

    expect(html).toContain("30 个会话");
    expect(html).toContain("50 个会话");
    expect(html).toContain("100 个会话");
    expect(html).toContain("不限制");
    expect(html).toContain('data-value="unlimited"');
  });
});
