import { describe, expect, it } from "vitest";

import {
  createUnsupportedModelInputMediaText,
  getUnsupportedModelInputMediaKind,
  isProviderVisibleModelInputMediaBlock,
} from "../src/index.js";

describe("model input media policy", () => {
  it("classifies unsupported images using shared model-visible placeholder text", () => {
    const block = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      source: { id: "image-1", kind: "inline" as const, placeholder: "[image #1]" },
    };

    expect(isProviderVisibleModelInputMediaBlock(block)).toBe(true);
    expect(
      getUnsupportedModelInputMediaKind(block, createInputFormat({ supportsImage: false })),
    ).toBe("image input");
    expect(createUnsupportedModelInputMediaText(block, "image input")).toBe(
      "[Attached image/png: [image #1]]\n[Media omitted from provider request because the selected model does not support image input.]",
    );
  });

  it("treats PDF file data as media only when extracted text is missing or empty", () => {
    const pdfWithText = {
      type: "file" as const,
      mediaType: "application/pdf",
      name: "report.pdf",
      dataUrl: "data:application/pdf;base64,cGRm",
      text: "extracted pdf text",
    };
    const emptyTextPdf = { ...pdfWithText, name: "empty.pdf", text: "" };

    expect(isProviderVisibleModelInputMediaBlock(pdfWithText)).toBe(false);
    expect(isProviderVisibleModelInputMediaBlock(emptyTextPdf)).toBe(true);
    expect(
      getUnsupportedModelInputMediaKind(emptyTextPdf, createInputFormat({ supportsPdf: false })),
    ).toBe("PDF input");
    expect(createUnsupportedModelInputMediaText(emptyTextPdf, "PDF input")).toBe(
      "[Attached application/pdf: empty.pdf]\n[Media omitted from provider request because the selected model does not support PDF input.]",
    );
  });

  it("classifies video file data using the model video capability", () => {
    const video = {
      type: "file" as const,
      mediaType: "video/mp4",
      name: "demo.mp4",
      dataUrl: "data:video/mp4;base64,dmlkZW8=",
    };

    expect(isProviderVisibleModelInputMediaBlock(video)).toBe(true);
    expect(
      getUnsupportedModelInputMediaKind(video, createInputFormat({ supportsVideo: false })),
    ).toBe("video input");
  });
});

function createInputFormat(
  override: Partial<{
    supportsText: boolean;
    supportsImage: boolean;
    supportsVideo: boolean;
    supportsAudio: boolean;
    supportsPdf: boolean;
  }> = {},
) {
  return {
    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: false,
    supportsPdf: true,
    ...override,
  };
}
