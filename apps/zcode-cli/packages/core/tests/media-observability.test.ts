import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import {
  logModelRequestMediaSummary,
  logResolvedTurnAttachments,
} from "../src/runtime/helpers/media-observability.js";

describe("model request media observability", () => {
  it("includes video blocks in the provider-visible media summary", () => {
    const debug = vi.fn();
    const logger = { debug } as unknown as Logger;
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "video" as const,
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
          },
        ],
      },
    ];

    logModelRequestMediaSummary(
      logger,
      { traceId: "trace_video_summary" },
      {
        incomingMessages: messages,
        mediaProjection: {
          messages,
          omittedMediaCount: 0,
          projectedMediaBytes: 5,
          retainedMediaCount: 1,
          totalMediaBytes: 5,
        },
        providerMessages: messages,
      },
    );

    expect(debug).toHaveBeenCalledWith(
      "Model request media summary",
      expect.objectContaining({
        incomingMediaBlockCount: 1,
        incomingMediaBlocks: [expect.objectContaining({ blockType: "video" })],
        providerMediaBlockCount: 1,
        providerMediaBlocks: [expect.objectContaining({ blockType: "video" })],
      }),
    );
  });

  it("counts resolved video attachments separately from files and images", () => {
    const debug = vi.fn();
    const logger = { debug } as unknown as Logger;

    logResolvedTurnAttachments(logger, { traceId: "trace_video_attachment" }, [
      {
        contentBlock: {
          type: "video",
          mediaType: "video/mp4",
          dataUrl: "data:video/mp4;base64,dmlkZW8=",
        },
        metadata: { recoverability: "provider_ready", storageKind: "inline" },
        mime: "video/mp4",
        url: "zcode-artifact://session/video-1",
      },
    ]);

    expect(debug).toHaveBeenCalledWith(
      "Turn attachments resolved",
      expect.objectContaining({
        fileAttachmentCount: 0,
        imageAttachmentCount: 0,
        videoAttachmentCount: 1,
      }),
    );
  });
});
