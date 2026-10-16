/** @vitest-environment jsdom */

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownImage } from "@/components/ai-elements/markdown-image.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

let optionalServices: {
  fileService: {
    readMediaPreview: () => Promise<{
      dataBase64: string;
      mediaType: string;
    }>;
  };
} | null = null;

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => optionalServices,
}));

function renderMarkdownImage(src: string, workspacePath?: string) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(MarkdownImage, { alt: "示例图", src, workspacePath }),
    ),
  );
}

afterEach(() => {
  cleanup();
  optionalServices = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MarkdownImage loading state", () => {
  it("远程图片加载完成前显示状态，完成后显示图片", () => {
    renderMarkdownImage("https://example.com/image.png");

    const loading = screen.getByRole("status", { name: "加载中..." });
    expect(loading.className).toContain("markdown-image-loading-shimmer");
    expect(loading.querySelector("svg")).not.toBeNull();
    const trigger = screen.getByRole("button", { name: "打开图片预览" });
    expect(trigger.className.split(" ")).toContain("!w-44");
    expect(trigger.className.split(" ")).toContain("!h-44");
    const image = screen.getByRole("img", { name: "示例图" });
    expect(image.className).toContain("invisible");

    fireEvent.load(image);

    expect(screen.queryByRole("status")).toBeNull();
    expect(trigger.className.split(" ")).not.toContain("!w-44");
    expect(trigger.className.split(" ")).not.toContain("!h-44");
    expect(image.className).not.toContain("invisible");
  });

  it("远程图片加载失败后显示不可用状态", () => {
    renderMarkdownImage("https://example.com/missing.png");

    fireEvent.error(screen.getByRole("img", { name: "示例图" }));

    expect(screen.queryByRole("status")).toBeNull();
    const unavailable = screen.getByRole("img", {
      name: "暂时无法显示这张图片。",
    });
    expect(unavailable.querySelector("svg")).not.toBeNull();
  });

  it("src 切换后忽略旧图片的失败事件", () => {
    const view = renderMarkdownImage("https://example.com/old.png");
    const oldImage = screen.getByRole("img", { name: "示例图" });

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(MarkdownImage, {
          alt: "示例图",
          src: "https://example.com/new.png",
        }),
      ),
    );
    fireEvent.error(oldImage);

    expect(screen.getByRole("status", { name: "加载中..." })).not.toBeNull();
    expect(screen.queryByLabelText("暂时无法显示这张图片。")).toBeNull();
  });

  it("卸载时清理预览关闭后的焦点恢复任务", () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = renderMarkdownImage("https://example.com/image.png");
    const image = screen.getByRole("img", { name: "示例图" });
    fireEvent.load(image);
    fireEvent.click(screen.getByRole("button", { name: "打开图片预览" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    focus.mockClear();

    view.unmount();
    vi.runAllTimers();

    expect(focus).not.toHaveBeenCalled();
  });

  it("本地预览数据无法解码时显示失败状态", async () => {
    optionalServices = {
      fileService: {
        readMediaPreview: async () => ({
          dataBase64: "broken",
          mediaType: "image/png",
        }),
      },
    };
    renderMarkdownImage("./broken.png", "/workspace");

    const image = await waitFor(() =>
      screen.getByRole("img", { name: "示例图" }),
    );
    fireEvent.error(image);

    expect(
      screen.getByRole("img", { name: "暂时无法显示这张图片。" }),
    ).not.toBeNull();
  });
});
