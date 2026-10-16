import assert from "node:assert/strict";
import test from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { renderMarkerPng } from "./multimodal-marker-png.mjs";
import { buildCase, CASE_NAMES, hasOrderedMarkers } from "./multimodal-tool-result-p0.mjs";

function decodeGrayscalePng(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const chunks = [];
  for (let offset = 8; offset < png.length; ) {
    const size = png.readUInt32BE(offset);
    const body = png.subarray(offset + 4, offset + 8 + size);
    assert.equal(png.readUInt32BE(offset + 8 + size), crc32(body), "PNG chunk CRC");
    chunks.push({ type: body.subarray(0, 4).toString(), data: body.subarray(4) });
    offset += size + 12;
    assert.ok(offset <= png.length, "complete chunk");
  }
  assert.deepEqual(
    chunks.map(({ type }) => type),
    ["IHDR", "IDAT", "IEND"],
  );
  const header = chunks[0].data;
  assert.deepEqual([...header.subarray(8)], [8, 0, 0, 0, 0]);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const pixels = inflateSync(chunks[1].data);
  assert.equal(pixels.length, (width + 1) * height);
  for (let y = 0; y < height; y++) assert.equal(pixels[y * (width + 1)], 0);
  return { width, height, pixels };
}

test("PNG stores visible marker pixels, preserves case and accommodates long markers", () => {
  const { width, height, pixels } = decodeGrayscalePng(renderMarkerPng("A_a012f"));
  assert.equal(height, 180);
  assert.ok(width >= 1000);
  // A 顶部留白、横线和左竖画：验证画的是字符，不是空图或仅含文本 metadata。
  const at = (x, y) => pixels[y * (width + 1) + 1 + x];
  assert.equal(at(30, 62), 255);
  assert.equal(at(38, 62), 0);
  assert.equal(at(30, 70), 0);
  assert.notDeepEqual(renderMarkerPng("A"), renderMarkerPng("a"));
  assert.notDeepEqual(renderMarkerPng("P0_VISUAL_012abc"), renderMarkerPng("P0_VISUAL_012abd"));
  const longest = decodeGrayscalePng(renderMarkerPng("W".repeat(128)));
  assert.ok(longest.width > 128 * 40, "last marker must not be clipped");
});

test("rejects unsupported marker characters and unbounded sizes", () => {
  for (const value of ["", "<svg>", "A B", "中文", "A".repeat(129), undefined]) {
    assert.throws(() => renderMarkerPng(value), /PNG marker/);
  }
});

test("all P0 tool-result shapes generate offline PNGs in their original marker order", async () => {
  let imageCount = 0;
  for (const name of CASE_NAMES) {
    const probe = await buildCase(name, "012abcdeff");
    const actual = [];
    for (const message of probe.messages) {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        for (const item of block.content) {
          if (item.type === "text") {
            actual.push(item.text);
          } else {
            assert.equal(item.type, "image");
            assert.equal(item.source.media_type, "image/png");
            const png = Buffer.from(item.source.data, "base64");
            decodeGrayscalePng(png);
            const marker = probe.expected.find((value) => renderMarkerPng(value).equals(png));
            assert.ok(marker, "image corresponds to an expected marker");
            actual.push(marker);
            imageCount++;
          }
        }
      }
    }
    assert.deepEqual(actual, probe.expected, name);
    assert.ok(hasOrderedMarkers(actual.join("\n"), probe.expected));
  }
  assert.equal(imageCount, 6);
});
