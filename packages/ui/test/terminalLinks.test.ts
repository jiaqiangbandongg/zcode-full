import { describe, expect, it } from "vitest";
import type { IBuffer, IBufferCell, IBufferLine } from "@xterm/xterm";
import {
  findHttpLinksInTerminalText,
  getHttpLinksForTerminalBufferLine,
} from "@/terminal/terminalLinks.js";

function createCell(chars: string): IBufferCell {
  return {
    getChars: () => chars,
    getWidth: () => 1,
  } as IBufferCell;
}

function createLine(text: string, cols: number, isWrapped = false): IBufferLine {
  return {
    isWrapped,
    getCell: (index: number) => {
      if (index < 0 || index >= cols) {
        return undefined;
      }

      return createCell(text[index] ?? "");
    },
  } as IBufferLine;
}

function createBuffer(lines: Array<{ text: string; isWrapped?: boolean }>, cols: number): IBuffer {
  const bufferLines = lines.map((line) => createLine(line.text, cols, line.isWrapped));
  return {
    length: bufferLines.length,
    getLine: (index: number) => bufferLines[index],
  } as IBuffer;
}

describe("terminalLinks", () => {
  it("detects http links and trims surrounding sentence punctuation", () => {
    expect(
      findHttpLinksInTerminalText(
        "Open (https://example.com/path_(ok)), then http://localhost:3000.",
      ),
    ).toEqual([
      {
        text: "https://example.com/path_(ok)",
        startIndex: 6,
        endIndex: 34,
      },
      {
        text: "http://localhost:3000",
        startIndex: 43,
        endIndex: 63,
      },
    ]);
  });

  it("maps a plain http link to xterm buffer coordinates", () => {
    const buffer = createBuffer([{ text: "see https://z.ai" }], 18);

    expect(getHttpLinksForTerminalBufferLine(buffer, 1, 18)).toEqual([
      {
        text: "https://z.ai",
        range: {
          start: { x: 5, y: 1 },
          end: { x: 16, y: 1 },
        },
        decorations: {
          underline: true,
          pointerCursor: true,
        },
      },
    ]);
  });

  it("keeps wrapped http links clickable from continuation lines", () => {
    const buffer = createBuffer(
      [
        { text: "run http:/" },
        { text: "/example.c", isWrapped: true },
        { text: "om done", isWrapped: true },
      ],
      10,
    );

    expect(getHttpLinksForTerminalBufferLine(buffer, 2, 10)).toEqual([
      {
        text: "http://example.com",
        range: {
          start: { x: 5, y: 1 },
          end: { x: 2, y: 3 },
        },
        decorations: {
          underline: true,
          pointerCursor: true,
        },
      },
    ]);
  });
});
