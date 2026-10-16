#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "zcode-image-payload-test";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PRESET = "below_limit";
const PRESETS = {
  tiny: 32 * 1024,
  below_limit: 180 * 1024,
  just_over_limit: 210 * 1024,
  large: 1024 * 1024,
  huge: 2 * 1024 * 1024,
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = buildCrcTable();

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "emit_image",
  {
    title: "Emit image with configurable base64 size",
    description:
      "Return a valid PNG image block whose base64 payload is near the requested size. Use this to test ZCode MCP image output budgeting.",
    inputSchema: {
      preset: z
        .enum(["tiny", "below_limit", "just_over_limit", "large", "huge"])
        .optional()
        .describe(
          "Convenience size preset. below_limit is under 200 KiB; just_over_limit is over 200 KiB.",
        ),
      base64Bytes: z
        .number()
        .int()
        .min(1024)
        .max(8 * 1024 * 1024)
        .optional()
        .describe("Target base64 payload bytes. Overrides preset when provided."),
      label: z
        .string()
        .max(80)
        .optional()
        .describe("Optional label included in the text summary."),
      dataUrl: z
        .boolean()
        .optional()
        .describe("When true, put a data URL in the image data field instead of raw base64."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ preset, base64Bytes, label, dataUrl }) => {
    const selectedPreset = preset ?? DEFAULT_PRESET;
    const targetBase64Bytes = base64Bytes ?? PRESETS[selectedPreset];
    const png = createPngNearBase64Size(targetBase64Bytes);
    const base64 = png.toString("base64");
    const actualBase64Bytes = Buffer.byteLength(base64, "utf8");
    const actualBinaryBytes = png.byteLength;
    const imageData = dataUrl === true ? `data:image/png;base64,${base64}` : base64;

    return {
      content: [
        {
          type: "text",
          text: [
            "ZCode MCP image payload test",
            `label=${label?.trim() || selectedPreset}`,
            `preset=${selectedPreset}`,
            `targetBase64Bytes=${targetBase64Bytes}`,
            `actualBase64Bytes=${actualBase64Bytes}`,
            `actualBinaryBytes=${actualBinaryBytes}`,
            `dataFormat=${dataUrl === true ? "data-url" : "raw-base64"}`,
          ].join("\n"),
        },
        {
          type: "image",
          mimeType: "image/png",
          data: imageData,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());

function createPngNearBase64Size(targetBase64Bytes) {
  const basePng = createPngWithTextPayload("");
  if (base64Length(basePng.byteLength) >= targetBase64Bytes) {
    return basePng;
  }

  let low = 0;
  let high = Math.max(1, Math.ceil((targetBase64Bytes * 3) / 4));
  while (base64Length(createPngWithTextPayloadLength(high).byteLength) < targetBase64Bytes) {
    high *= 2;
  }

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = createPngWithTextPayloadLength(mid);
    if (base64Length(candidate.byteLength) >= targetBase64Bytes) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return createPngWithTextPayloadLength(low);
}

function createPngWithTextPayloadLength(length) {
  return createPngWithTextPayload("z".repeat(length));
}

function createPngWithTextPayload(textPayload) {
  const width = 1;
  const height = 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanline = Buffer.from([0x00, 0x2f, 0x80, 0xff, 0xff]);
  const idat = deflateSync(scanline, { level: 9 });
  const text = Buffer.from(`zcode-mcp-payload\0${textPayload}`, "latin1");

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
