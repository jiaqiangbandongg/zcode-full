import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getImagePreviewPixelRatio,
  ImagePreviewContent,
  SvgPreviewContent,
} from "@/previewPaneImageContent.js";

describe("ImagePreviewContent", () => {
  it("centers the image and preserves natural size until it reaches the pane bounds", () => {
    const html = renderToStaticMarkup(
      createElement(ImagePreviewContent, {
        title: "logo.png",
        imageSource: "data:image/png;base64,",
      }),
    );

    expect(html).toContain("flex h-full min-h-0 items-center justify-center");
    expect(html).toContain("p-10");
    expect(html).toContain("[background-color:var(--color-background)]");
    expect(html).toContain("[background-image:linear-gradient(45deg,var(--color-surface)_25%,transparent_25%)");
    expect(html).toContain("[background-position:0_0,0_4px,4px_-4px,-4px_0]");
    expect(html).toContain("[background-size:8px_8px]");
    expect(html).toContain("h-auto max-h-full w-auto max-w-full");
    expect(html).not.toContain("rounded");
    expect(html).not.toMatch(/\sw-full(\s|")/);
  });

  it("detects retina pixel ratios from image file names", () => {
    expect(getImagePreviewPixelRatio("/tmp/logo@2x.png")).toBe(2);
    expect(getImagePreviewPixelRatio("icon@3x.webp")).toBe(3);
    expect(getImagePreviewPixelRatio("asset@1.5x.avif")).toBe(1.5);
    expect(getImagePreviewPixelRatio("/tmp/@2x/logo.png")).toBe(1);
    expect(getImagePreviewPixelRatio("logo@0x.png")).toBe(1);
    expect(getImagePreviewPixelRatio("logo@2x.backup.png")).toBe(1);
  });

  it("fits svg previews to the container instead of using bitmap natural sizing", () => {
    const html = renderToStaticMarkup(
      createElement(SvgPreviewContent, {
        title: "logo@2x.svg",
        svgContent:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
      }),
    );

    expect(html).toContain("h-full max-h-full w-full max-w-full");
    expect(html).not.toContain("h-auto max-h-full w-auto max-w-full");
  });
});
