// @vitest-environment jsdom
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(() => vi.restoreAllMocks());

describe("MessageResponse artifact session changes", () => {
  it("releases the old image and reads through the new session context", async () => {
    const ref = "zcode-artifact://session-a/cua-shot";
    const markdown = `![shot](${ref})`;
    const readSessionA = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1]),
      mediaType: "image/png",
    });
    const readSessionB = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([2]),
      mediaType: "image/png",
    });
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:session-a")
      .mockReturnValueOnce("blob:session-b");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const renderMessage = (sessionId: string, readAttachment: typeof readSessionA) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            sessionId,
            readAttachment,
            theme: "light",
            workspacePath: "/workspace",
          },
          markdown,
        ),
      );

    const rendered = render(renderMessage("session-a", readSessionA));
    await waitFor(() =>
      expect(rendered.container.querySelector("img")?.getAttribute("src")).toBe("blob:session-a"),
    );

    rendered.rerender(renderMessage("session-b", readSessionB));

    await waitFor(() =>
      expect(rendered.container.querySelector("img")?.getAttribute("src")).toBe("blob:session-b"),
    );
    expect(revoke).toHaveBeenCalledWith("blob:session-a");
    expect(readSessionA).toHaveBeenCalledTimes(1);
    expect(readSessionB).toHaveBeenCalledWith({ sessionId: "session-b", ref });
  });
});
