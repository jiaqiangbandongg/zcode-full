import { describe, expect, it, vi } from "vitest";
import type { ModelInputFormat, ModelInputMessage, ToolArtifactStorePort } from "@zcode/contracts";
import { projectMessagesWithMediaAttachmentPaths } from "../src/runtime/helpers/media-attachment-path.js";
import { projectMessagesForInputFormat as projectMessages } from "../src/runtime/helpers/media-capability.js";

function projectMessagesForInputFormat(
  messages: ModelInputMessage[],
  override?: Partial<ModelInputFormat>,
) {
  return projectMessages(messages, {
    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: false,
    supportsPdf: true,
    ...override,
  });
}

describe("model request media capability projection", () => {
  it("appends ordered image source paths before explicit text-only stripping", async () => {
    const ensureMediaAttachmentPath = vi.fn(async ({ uri }: { uri: string }) => ({
      status: "ready" as const,
      path: uri.endsWith("image-1") ? "/tmp/image-1.png" : "/tmp/image-2.jpg",
    }));
    const artifactStore = {
      ensureMediaAttachmentPath,
    } as unknown as ToolArtifactStorePort;
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "compare these" },
          {
            type: "image",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,b25l",
            source: { id: "image-1", kind: "inline", uri: "zcode-artifact://s/image-1" },
          },
          {
            type: "image",
            mediaType: "image/jpeg",
            dataUrl: "data:image/jpeg;base64,dHdv",
            source: { id: "image-2", kind: "inline", uri: "zcode-artifact://s/image-2" },
          },
        ],
      },
    ];

    const withPaths = await projectMessagesWithMediaAttachmentPaths(messages, artifactStore);

    expect(ensureMediaAttachmentPath).toHaveBeenCalledTimes(2);
    expect(withPaths[0]?.content).toEqual([
      { type: "text", text: "compare these" },
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ path: "/tmp/image-1.png" }),
      }),
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ path: "/tmp/image-2.jpg" }),
      }),
      { type: "text", text: "[Image: source: /tmp/image-1.png]" },
      { type: "text", text: "[Image: source: /tmp/image-2.jpg]" },
    ]);
    expect(projectMessagesForInputFormat(withPaths, { supportsVideo: undefined }).messages).toBe(
      withPaths,
    );

    const textOnly = projectMessagesForInputFormat(withPaths, {
      supportsImage: false,
    }).messages;
    expect(textOnly[0]?.content).toEqual([
      { type: "text", text: "compare these" },
      expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
      { type: "text", text: "[Image: source: /tmp/image-1.png]" },
      { type: "text", text: "[Image: source: /tmp/image-2.jpg]" },
    ]);
    expect(JSON.stringify(textOnly)).not.toContain('"type":"image"');
    expect(JSON.stringify(textOnly)).not.toContain("data:image");
  });

  it("appends a video source path for supported, unknown, and unsupported models", async () => {
    const ensureMediaAttachmentPath = vi.fn(async () => ({
      status: "ready" as const,
      path: "/tmp/video-1.mp4",
    }));
    const artifactStore = { ensureMediaAttachmentPath } as unknown as ToolArtifactStorePort;
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this video" },
          {
            type: "video",
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
            source: {
              id: "video-1",
              kind: "inline",
              uri: "zcode-artifact://s/video-1",
            },
          },
        ],
      },
    ];

    const withPaths = await projectMessagesWithMediaAttachmentPaths(messages, artifactStore);

    expect(ensureMediaAttachmentPath).toHaveBeenCalledWith({
      mediaType: "video/mp4",
      uri: "zcode-artifact://s/video-1",
    });
    expect(withPaths[0]?.content).toEqual([
      { type: "text", text: "describe this video" },
      expect.objectContaining({
        type: "video",
        source: expect.objectContaining({ path: "/tmp/video-1.mp4" }),
      }),
      { type: "text", text: "[Video: source: /tmp/video-1.mp4]" },
    ]);
    expect(projectMessagesForInputFormat(withPaths, { supportsVideo: true }).messages).toBe(
      withPaths,
    );
    expect(projectMessagesForInputFormat(withPaths, undefined).messages).toBe(withPaths);

    const textOnly = projectMessagesForInputFormat(withPaths, {
      supportsVideo: false,
    }).messages;
    expect(textOnly[0]?.content).toEqual([
      { type: "text", text: "describe this video" },
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("does not support video input"),
      }),
      { type: "text", text: "[Video: source: /tmp/video-1.mp4]" },
    ]);
    expect(JSON.stringify(textOnly)).not.toContain('"type":"video"');
    expect(JSON.stringify(textOnly)).not.toContain("data:video");
  });

  it("reuses a local video path without an artifact store", async () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "video",
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
            source: {
              id: "video-1",
              kind: "local_file",
              path: "/workspace/video-1.mp4",
            },
          },
        ],
      },
    ];

    const projected = await projectMessagesWithMediaAttachmentPaths(messages, undefined);

    expect(projected[0]?.content).toEqual([
      expect.objectContaining({
        type: "video",
        source: expect.objectContaining({ path: "/workspace/video-1.mp4" }),
      }),
      { type: "text", text: "[Video: source: /workspace/video-1.mp4]" },
    ]);
  });

  it("fails before the provider boundary when a durable inline video cannot be materialized", async () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "video",
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
            source: {
              id: "video-1",
              kind: "inline",
              uri: "zcode-artifact://s/video-1",
            },
          },
        ],
      },
    ];

    await expect(projectMessagesWithMediaAttachmentPaths(messages, undefined)).rejects.toThrow(
      "Unable to materialize video attachment path",
    );
  });

  it("keeps generic inline video on the existing capability path", async () => {
    const ensureMediaAttachmentPath = vi.fn(async () => ({
      status: "ready" as const,
      path: "/tmp/should-not-be-used.mp4",
    }));
    const artifactStore = { ensureMediaAttachmentPath } as unknown as ToolArtifactStorePort;
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "video",
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
            source: { id: "generic-video", kind: "inline" },
          },
        ],
      },
    ];

    await expect(projectMessagesWithMediaAttachmentPaths(messages, artifactStore)).resolves.toBe(
      messages,
    );
    expect(ensureMediaAttachmentPath).not.toHaveBeenCalled();
  });

  it("fails before the provider boundary when a durable inline image cannot be materialized", async () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,b25l",
            source: {
              id: "image-1",
              kind: "inline",
              uri: "zcode-artifact://s/image-1",
            },
          },
        ],
      },
    ];

    await expect(projectMessagesWithMediaAttachmentPaths(messages, undefined)).rejects.toThrow(
      "Unable to materialize image attachment path",
    );
  });

  it.each([
    ["without a URI", { id: "generic-image", kind: "inline" as const }],
    [
      "with a data URL URI",
      {
        id: "legacy-inline-image",
        kind: "inline" as const,
        uri: "data:image/png;base64,aW1hZ2U=",
      },
    ],
  ])(
    "keeps generic inline images %s on the existing media-capability path",
    async (_label, source) => {
      const ensureMediaAttachmentPath = vi.fn(async () => ({
        status: "ready" as const,
        path: "/tmp/should-not-be-used.png",
      }));
      const artifactStore = {
        ensureMediaAttachmentPath,
      } as unknown as ToolArtifactStorePort;
      const messages: ModelInputMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
              source,
            },
          ],
        },
      ];

      const withPaths = await projectMessagesWithMediaAttachmentPaths(messages, artifactStore);

      expect(withPaths).toBe(messages);
      expect(ensureMediaAttachmentPath).not.toHaveBeenCalled();
      expect(projectMessagesForInputFormat(withPaths, { supportsImage: true }).messages).toBe(
        messages,
      );
      expect(projectMessagesForInputFormat(withPaths, undefined).messages).toBe(messages);

      const textOnly = projectMessagesForInputFormat(withPaths, {
        supportsImage: false,
      }).messages;
      expect(textOnly[0]?.content).toEqual([
        { type: "text", text: "describe this" },
        expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
      ]);
      expect(JSON.stringify(textOnly)).not.toContain('"type":"image"');
      expect(JSON.stringify(textOnly)).not.toContain("data:image");
    },
  );

  it("revalidates a durable inline image instead of trusting a projected source path", async () => {
    const ensureMediaAttachmentPath = vi.fn(async () => ({
      status: "ready" as const,
      path: "/tmp/rebuilt-image.png",
    }));
    const artifactStore = {
      ensureMediaAttachmentPath,
    } as unknown as ToolArtifactStorePort;
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,b25l",
            source: {
              id: "image-1",
              kind: "inline",
              path: "/tmp/stale-image.png",
              uri: "zcode-artifact://s/image-1",
            },
          },
        ],
      },
    ];

    const projected = await projectMessagesWithMediaAttachmentPaths(messages, artifactStore);

    expect(ensureMediaAttachmentPath).toHaveBeenCalledWith({
      mediaType: "image/png",
      uri: "zcode-artifact://s/image-1",
    });
    expect(projected[0]?.content).toEqual([
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ path: "/tmp/rebuilt-image.png" }),
      }),
      { type: "text", text: "[Image: source: /tmp/rebuilt-image.png]" },
    ]);
  });

  it("skips only unsupported derived paths while preserving image and text-only projection", async () => {
    const ensureMediaAttachmentPath = vi.fn(async ({ mediaType }: { mediaType: string }) =>
      mediaType === "image/bmp"
        ? ({ status: "unsupported" } as const)
        : ({ status: "ready", path: "/tmp/image-1.png" } as const),
    );
    const artifactStore = {
      ensureMediaAttachmentPath,
    } as unknown as ToolArtifactStorePort;
    const png = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,b25l",
      source: { id: "image-1", kind: "inline" as const, uri: "zcode-artifact://s/image-1" },
    };
    const bmp = {
      type: "image" as const,
      mediaType: "image/bmp",
      dataUrl: "data:image/bmp;base64,dHdv",
      source: { id: "image-2", kind: "inline" as const, uri: "zcode-artifact://s/image-2" },
    };
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "compare these" }, png, bmp],
      },
    ];

    const withPaths = await projectMessagesWithMediaAttachmentPaths(messages, artifactStore);

    expect(ensureMediaAttachmentPath).toHaveBeenCalledTimes(2);
    expect(withPaths[0]?.content).toEqual([
      { type: "text", text: "compare these" },
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ path: "/tmp/image-1.png" }),
      }),
      bmp,
      { type: "text", text: "[Image: source: /tmp/image-1.png]" },
    ]);
    const projectedContent = withPaths[0]?.content;
    expect(Array.isArray(projectedContent) ? projectedContent[2] : undefined).toStrictEqual(bmp);

    const textOnly = projectMessagesForInputFormat(withPaths, {
      supportsImage: false,
    }).messages;
    expect(textOnly[0]?.content).toEqual([
      { type: "text", text: "compare these" },
      expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
      { type: "text", text: "[Image: source: /tmp/image-1.png]" },
    ]);
    expect(JSON.stringify(textOnly)).not.toContain('"type":"image"');
    expect(JSON.stringify(textOnly)).not.toContain("data:image");
  });

  it("replaces user image blocks when the model explicitly does not support images", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,aW1hZ2U=",
            source: { id: "image-1", kind: "inline", placeholder: "[image #1]" },
          },
        ],
      },
    ];

    const result = projectMessagesForInputFormat(messages, { supportsImage: false });

    expect(result.omittedMediaCount).toBe(1);
    expect(result.omittedImageCount).toBe(1);
    expect(result.retainedMediaCount).toBe(0);
    expect(result.messages).not.toBe(messages);
    expect(result.messages[0]?.content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "text",
        text: "[Attached image/png: [image #1]]\n[Media omitted from provider request because the selected model does not support image input.]",
      },
    ]);
  });

  it("keeps image blocks when support is true or unknown", () => {
    const image = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    };
    const messages: ModelInputMessage[] = [{ role: "user", content: [image] }];

    expect(projectMessagesForInputFormat(messages, { supportsImage: true }).messages).toBe(
      messages,
    );
    expect(projectMessagesForInputFormat(messages, {}).messages).toBe(messages);
    expect(projectMessagesForInputFormat(messages, undefined).messages).toBe(messages);
  });

  it("replaces PDF file data when PDF support is explicitly false", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "application/pdf",
            name: "report.pdf",
            dataUrl: "data:application/pdf;base64,cGRm",
          },
        ],
      },
    ];

    const result = projectMessagesForInputFormat(messages, { supportsPdf: false });

    expect(result.omittedPdfCount).toBe(1);
    expect(result.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "[Attached application/pdf: report.pdf]\n[Media omitted from provider request because the selected model does not support PDF input.]",
      },
    ]);
  });

  it("replaces video file data when video support is explicitly false", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "video/mp4",
            name: "demo.mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
          },
        ],
      },
    ];

    const result = projectMessagesForInputFormat(messages, { supportsVideo: false });

    expect(result.omittedMediaCount).toBe(1);
    expect(result.retainedMediaCount).toBe(0);
    expect(result.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "[Attached video/mp4: demo.mp4]\n[Media omitted from provider request because the selected model does not support video input.]",
      },
    ]);
  });

  it("replaces PDF file data when extracted PDF text is empty", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "application/pdf",
            name: "empty-text.pdf",
            dataUrl: "data:application/pdf;base64,cGRm",
            text: "",
          },
        ],
      },
    ];

    const result = projectMessagesForInputFormat(messages, { supportsPdf: false });

    expect(result.omittedPdfCount).toBe(1);
    expect(result.retainedMediaCount).toBe(0);
    expect(result.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "[Attached application/pdf: empty-text.pdf]\n[Media omitted from provider request because the selected model does not support PDF input.]",
      },
    ]);
  });

  it("counts stripped video blocks in capability observability", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "video",
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
          },
        ],
      },
    ];

    const result = projectMessagesForInputFormat(messages, { supportsVideo: false });

    expect(result.omittedMediaCount).toBe(1);
    expect(result.omittedVideoCount).toBe(1);
    expect(result.retainedMediaCount).toBe(0);
    expect(JSON.stringify(result.messages)).not.toContain('"type":"video"');
  });
});
