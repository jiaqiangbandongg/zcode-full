import { describe, it, expect } from "vitest";
import { VSBuffer } from "../src/buffer.js";

describe("VSBuffer", () => {
  it("alloc should create a zero-filled buffer", () => {
    const buf = VSBuffer.alloc(4);
    expect(buf.byteLength).toBe(4);
    expect(buf.buffer.every((b) => b === 0)).toBe(true);
  });

  it("wrap should wrap existing Uint8Array", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const buf = VSBuffer.wrap(raw);
    expect(buf.byteLength).toBe(3);
    expect(buf.buffer).toBe(raw);
  });

  it("fromString / toString roundtrip", () => {
    const text = "hello 你好 🌍";
    const buf = VSBuffer.fromString(text);
    expect(buf.toString()).toBe(text);
  });

  it("concat should merge multiple buffers", () => {
    const a = VSBuffer.fromString("ab");
    const b = VSBuffer.fromString("cd");
    const result = VSBuffer.concat([a, b]);
    expect(result.toString()).toBe("abcd");
    expect(result.byteLength).toBe(a.byteLength + b.byteLength);
  });

  it("slice should return a sub-buffer", () => {
    const buf = VSBuffer.fromString("hello");
    const sub = buf.slice(1, 3);
    expect(sub.toString()).toBe("el");
  });

  it("set should copy data at offset", () => {
    const buf = VSBuffer.alloc(4);
    const src = VSBuffer.wrap(new Uint8Array([0xaa, 0xbb]));
    buf.set(src, 1);
    expect(buf.readUInt8(0)).toBe(0);
    expect(buf.readUInt8(1)).toBe(0xaa);
    expect(buf.readUInt8(2)).toBe(0xbb);
    expect(buf.readUInt8(3)).toBe(0);
  });

  it("readUInt32BE / writeUInt32BE roundtrip", () => {
    const buf = VSBuffer.alloc(8);
    buf.writeUInt32BE(0x12345678, 0);
    buf.writeUInt32BE(0xdeadbeef, 4);
    expect(buf.readUInt32BE(0)).toBe(0x12345678);
    expect(buf.readUInt32BE(4)).toBe(0xdeadbeef);
  });

  it("readUInt32BE should handle max value", () => {
    const buf = VSBuffer.alloc(4);
    buf.writeUInt32BE(0xffffffff, 0);
    expect(buf.readUInt32BE(0)).toBe(0xffffffff);
  });
});
