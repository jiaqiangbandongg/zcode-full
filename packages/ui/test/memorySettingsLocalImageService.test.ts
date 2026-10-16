// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { MarkdownImage } from "@/components/ai-elements/markdown-image.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

function createServices(
  readMediaPreview: ReturnType<typeof vi.fn>,
): IServiceAccessor {
  return {
    fileService: { readMediaPreview },
  } as unknown as IServiceAccessor;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Project Memory local image service boundary", () => {
  it("uses the local provider instead of the outer remote provider", async () => {
    const remoteReadMediaPreview = vi.fn();
    const localReadMediaPreview = vi.fn(async () => ({
      dataBase64: "aW1hZ2U=",
      mediaType: "image/png",
    }));

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: createServices(remoteReadMediaPreview) },
          createElement(
            ServiceProvider,
            { services: createServices(localReadMediaPreview) },
            createElement(MarkdownImage, {
              alt: "本地记忆图片",
              src: "/tmp/memory-image.png",
            }),
          ),
        ),
      ),
    );

    await waitFor(() => {
      expect(localReadMediaPreview).toHaveBeenCalledWith({
        path: "/tmp/memory-image.png",
      });
    });
    expect(remoteReadMediaPreview).not.toHaveBeenCalled();
  });
});
