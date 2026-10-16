import { describe, it, expect } from "vitest";
import { VSBuffer } from "../src/buffer.js";
import { BufferReader, BufferWriter, serialize, deserialize } from "../src/serialization.js";

function roundtrip(data: any): any {
  const writer = new BufferWriter();
  serialize(writer, data);
  const reader = new BufferReader(writer.buffer);
  return deserialize(reader);
}

describe("serialization", () => {
  it("should roundtrip undefined", () => {
    expect(roundtrip(undefined)).toBeUndefined();
  });

  it("should roundtrip strings", () => {
    expect(roundtrip("")).toBe("");
    expect(roundtrip("hello")).toBe("hello");
    expect(roundtrip("你好🌍")).toBe("你好🌍");
  });

  it("should roundtrip integers", () => {
    expect(roundtrip(0)).toBe(0);
    expect(roundtrip(1)).toBe(1);
    expect(roundtrip(127)).toBe(127);
    expect(roundtrip(128)).toBe(128);
    expect(roundtrip(65535)).toBe(65535);
  });

  it("should roundtrip arrays", () => {
    expect(roundtrip([])).toEqual([]);
    expect(roundtrip([1, 2, 3])).toEqual([1, 2, 3]);
    expect(roundtrip(["a", "b"])).toEqual(["a", "b"]);
  });

  it("should roundtrip nested arrays", () => {
    expect(roundtrip([1, [2, 3], "four"])).toEqual([1, [2, 3], "four"]);
  });

  it("should roundtrip objects via JSON fallback", () => {
    expect(roundtrip({ a: 1, b: "two" })).toEqual({ a: 1, b: "two" });
  });

  it("should roundtrip VSBuffer", () => {
    const original = VSBuffer.fromString("binary data");
    const result = roundtrip(original);
    expect(result).toBeInstanceOf(VSBuffer);
    expect(result.toString()).toBe("binary data");
  });

  it("should roundtrip Uint8Array", () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const result = roundtrip(original);
    expect(result).toBeInstanceOf(Uint8Array);
    expect([...result]).toEqual([1, 2, 3, 4]);
  });

  it("should roundtrip floats via JSON fallback", () => {
    expect(roundtrip(3.14)).toBeCloseTo(3.14);
  });

  it("should roundtrip booleans via JSON fallback", () => {
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
  });

  it("should handle multiple serialize/deserialize in sequence", () => {
    const writer = new BufferWriter();
    serialize(writer, "hello");
    serialize(writer, 42);
    serialize(writer, [1, 2]);

    const reader = new BufferReader(writer.buffer);
    expect(deserialize(reader)).toBe("hello");
    expect(deserialize(reader)).toBe(42);
    expect(deserialize(reader)).toEqual([1, 2]);
  });
});

describe("BufferReader / BufferWriter", () => {
  it("should read sequentially", () => {
    const buf = VSBuffer.fromString("abcdef");
    const reader = new BufferReader(buf);
    expect(reader.read(3).toString()).toBe("abc");
    expect(reader.read(3).toString()).toBe("def");
  });

  it("BufferWriter should concat all writes", () => {
    const writer = new BufferWriter();
    writer.write(VSBuffer.fromString("hello"));
    writer.write(VSBuffer.fromString(" world"));
    expect(writer.buffer.toString()).toBe("hello world");
  });
});
