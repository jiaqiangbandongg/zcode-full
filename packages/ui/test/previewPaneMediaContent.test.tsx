import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewPaneMediaContent } from "@/previewPaneMediaContent.js";

describe("PreviewPaneMediaContent", () => {
  const labels = {
    loading: "Loading",
    unavailable: "Unavailable",
    unsupported: "Unsupported",
  };

  it("renders a native video player without autoplay", () => {
    const html = renderToStaticMarkup(
      createElement(PreviewPaneMediaContent, {
        source: {
          type: "media",
          kind: "video",
          mediaType: "video/mp4",
          title: "clip.mp4",
          path: "/workspace/clip.mp4",
        },
        loading: false,
        url: "zcode-media://local/preview",
        error: null,
        labels,
        onMediaError: () => undefined,
      }),
    );

    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).toContain("playsinline");
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain("autoplay");
  });

  it("renders a native audio player", () => {
    const html = renderToStaticMarkup(
      createElement(PreviewPaneMediaContent, {
        source: {
          type: "media",
          kind: "audio",
          mediaType: "audio/mpeg",
          title: "song.mp3",
          path: "/workspace/song.mp3",
        },
        loading: false,
        url: "blob:media",
        error: null,
        labels,
        onMediaError: () => undefined,
      }),
    );

    expect(html).toContain("<audio");
    expect(html).toContain("controls");
    expect(html).toContain('preload="metadata"');
  });
});
