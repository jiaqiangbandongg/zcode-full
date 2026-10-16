import { describe, expect, it } from "vitest";
import { getMediaPreviewFormat } from "@zcode/shared";

describe("media preview formats", () => {
  it.each([
    ["clip.mp4", "video", "video/mp4"],
    ["clip.mov", "video", "video/quicktime"],
    ["clip.webm", "video", "video/webm"],
    ["clip.m4v", "video", "video/x-m4v"],
    ["song.mp3", "audio", "audio/mpeg"],
    ["song.wav", "audio", "audio/wav"],
    ["song.m4a", "audio", "audio/mp4"],
    ["song.ogg", "audio", "audio/ogg"],
    ["song.opus", "audio", "audio/opus"],
    ["song.flac", "audio", "audio/flac"],
    ["song.weba", "audio", "audio/webm"],
  ])("resolves %s", (path, kind, mediaType) => {
    expect(getMediaPreviewFormat(path)).toMatchObject({ kind, mediaType });
  });

  it("normalizes Windows separators and rejects unsupported containers", () => {
    expect(getMediaPreviewFormat("dist\\demo\\clip.MP4")).toMatchObject({
      kind: "video",
      mediaType: "video/mp4",
    });
    expect(getMediaPreviewFormat("clip.mkv")).toBeNull();
  });
});
