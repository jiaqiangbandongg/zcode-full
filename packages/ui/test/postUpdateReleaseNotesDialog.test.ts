import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "markdown" }, children),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children }: { children: unknown }) =>
    createElement("button", { type: "button" }, children),
}));

vi.mock("@/components/ui/GlmMonochromeIcon.js", () => ({
  GlmMonochromeIcon: () => createElement("span", { "data-testid": "glm-icon" }),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? createElement("div", { "data-testid": "dialog-root" }, children) : null,
  DialogContent: ({ children, ...props }: Record<string, unknown>) =>
    createElement("div", props, children),
  DialogTitle: ({ children }: { children: unknown }) => createElement("h1", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: vi.fn((descriptor: { id: string }) => {
        if (descriptor.id === "postUpdateReleaseNotes.acknowledge") {
          return "I know";
        }
        if (descriptor.id === "postUpdateReleaseNotes.title") {
          return "Release notes";
        }
        return descriptor.id;
      }),
    },
  }),
}));

describe("PostUpdateReleaseNotesDialog", () => {
  it("falls back to localized default title when payload title is empty", async () => {
    const { PostUpdateReleaseNotesDialog } = await import("@/root/PostUpdateReleaseNotesDialog.js");

    const html = renderToStaticMarkup(
      createElement(PostUpdateReleaseNotesDialog, {
        payload: {
          version: "0.1.25",
          title: "   ",
          markdown: "## New Features\n\n- add popup",
        },
        onAcknowledge: vi.fn(),
      }),
    );

    expect(html).toContain("Release notes");
  });
});
