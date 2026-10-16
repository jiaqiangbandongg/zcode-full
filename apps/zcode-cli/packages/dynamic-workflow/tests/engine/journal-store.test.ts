import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, canonicalJson, fnv1a, inputHash } from "../../src/engine/index.js";
import { runJournalStoreContract } from "../../src/testing/journal-contract.js";

// 内存实现跑通共享契约；SQLite 实现在 @zcode/adapters 经 `@zcode/dynamic-workflow/testing` 跑同一份。
runJournalStoreContract(() => new InMemoryJournalStore());

describe("canonicalJson", () => {
  it("sorts object keys so semantically equal values serialize identically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("is stable across nesting and arrays", () => {
    expect(canonicalJson({ x: [{ z: 1, y: 2 }] })).toBe('{"x":[{"y":2,"z":1}]}');
  });

  it("skips undefined members like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("fnv1a / inputHash", () => {
  it("is deterministic and 8-hex-wide", () => {
    const h = fnv1a("hello");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("hello")).toBe(h);
  });

  it("distinguishes different inputs", () => {
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });

  it("hashes canonical JSON so key order does not change the hash", () => {
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
    expect(inputHash("do it")).not.toBe(inputHash("do that"));
  });
});
