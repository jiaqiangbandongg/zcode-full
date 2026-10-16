import { describe, expect, it } from "vitest";
import { projectInputHistoryAttachments } from "../src/app/prompt-input.js";

describe("projectInputHistoryAttachments", () => {
  it("只把 legacy input history 支持的附件投影到存储契约", () => {
    expect(
      projectInputHistoryAttachments([
        {
          content: "zcode-artifact://session/image",
          path: "[image #1]",
          type: "image",
        },
        {
          content: "data:video/mp4;base64,dmlkZW8=",
          path: "[video #1]",
          type: "video",
        },
        {
          path: "/tmp/notes.txt",
          sourceKind: "clipboard-text",
          type: "file",
        },
        {
          content: "https://example.com",
          type: "url",
        },
      ]),
    ).toEqual([
      {
        content: "zcode-artifact://session/image",
        path: "[image #1]",
        type: "image",
      },
      {
        path: "/tmp/notes.txt",
        type: "file",
      },
      {
        content: "https://example.com",
        type: "url",
      },
    ]);
  });

  it("没有可持久化附件时返回 undefined", () => {
    expect(
      projectInputHistoryAttachments([
        {
          content: "data:video/mp4;base64,dmlkZW8=",
          type: "video",
        },
      ]),
    ).toBeUndefined();
  });
});
