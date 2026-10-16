// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import bigModelLogo from "@/assets/provider-icons/logo-bigmodel.svg";
import {
  ProviderLogo,
  resolveBuiltinProviderLogoAsset,
} from "@/settings/model-provider-section/ProviderLogo.js";

describe("ProviderLogo", () => {
  it.each(["light", "dark"] as const)(
    "Z.AI 在 %s 主题复用系统图标，BigModel 保持原素材",
    (theme) => {
      expect(resolveBuiltinProviderLogoAsset({ type: "builtin", key: "zai" }, theme)).toMatch(
        /model-provider-zai-app\.png(?:\?|$)/,
      );
      expect(resolveBuiltinProviderLogoAsset({ type: "builtin", key: "bigmodel" }, theme)).toBe(
        bigModelLogo,
      );
    },
  );

  it("Z.AI 渲染 Dock 应用 PNG 并保留原尺寸和装饰图片语义", () => {
    const { container } = render(
      createElement(ProviderLogo, {
        logo: { type: "builtin", key: "zai" },
        className: "size-5",
      }),
    );
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toMatch(/model-provider-zai-app\.png(?:\?|$)/);
    expect(image.classList.contains("size-5")).toBe(true);
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("aria-hidden")).toBe("true");
    fireEvent.error(image);
    expect(container.querySelector(".lucide-package")).not.toBeNull();
  });

  it.each(["openrouter", "opencode"])("聚合供应商 %s 使用已打包的深浅主题资源", (key) => {
    const light = resolveBuiltinProviderLogoAsset({ type: "builtin", key }, "light");
    const dark = resolveBuiltinProviderLogoAsset({ type: "builtin", key }, "dark");
    expect(light).toBeTypeOf("string");
    expect(dark).toBeTypeOf("string");
    expect(light).not.toBe(dark);
    expect(light).not.toMatch(/^https?:/);
    expect(dark).not.toMatch(/^https?:/);
  });
  it("解析已知资源，并让未知或缺失 key 回退通用图标", () => {
    expect(resolveBuiltinProviderLogoAsset({ type: "builtin", key: "deepseek" }, "light")).toBe(
      resolveBuiltinProviderLogoAsset({ type: "builtin", key: "deepseek" }, "dark"),
    );
    expect(resolveBuiltinProviderLogoAsset({ type: "builtin", key: "future-brand" }, "light")).toBe(
      null,
    );
    expect(resolveBuiltinProviderLogoAsset(undefined, "light")).toBe(null);

    const known = renderToStaticMarkup(
      createElement(ProviderLogo, {
        logo: { type: "builtin", key: "deepseek" },
        className: "size-5",
      }),
    );
    const unknown = renderToStaticMarkup(
      createElement(ProviderLogo, {
        logo: { type: "builtin", key: "future-brand" },
        className: "size-5",
      }),
    );
    expect(known).toContain("<img");
    expect(known).toContain('alt=""');
    expect(unknown).toContain("lucide-package");
  });

  it("打包资源加载失败时回退通用图标", () => {
    const { container } = render(
      createElement(ProviderLogo, {
        logo: { type: "builtin", key: "deepseek" },
        className: "size-5",
      }),
    );
    const image = container.querySelector("img");
    expect(image).not.toBeNull();

    fireEvent.error(image!);

    expect(container.querySelector(".lucide-package")).not.toBeNull();
  });
});
