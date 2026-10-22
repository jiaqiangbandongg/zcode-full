import { describe, expect, it } from "vitest";
import { snippet, truncateBytes } from "#office/domain/model.ts";
import { cut, wellFormed, wellFormedDeep } from "#office/domain/text.ts";

const MATH = "roots(Γ, {𝑥, 𝑦})"; // 𝑥 and 𝑦 are two UTF-16 units each
const whole = (text: string) => wellFormed(text) === text;

describe("cut", () => {
  it("never leaves half a character at either end", () => {
    for (let start = 0; start <= MATH.length; start++)
      for (let end = start; end <= MATH.length; end++)
        expect(whole(cut(MATH, start, end))).toBe(true);
  });
  it("matches slice when no character is split", () => {
    expect(cut("hello", 1, 3)).toBe("el");
  });
});

describe("text helpers built on cut", () => {
  it("snippets and byte budgets stay well formed", () => {
    const text = `${"a".repeat(55)}${"𝑅𝐴".repeat(40)}`;
    for (let index = 0; index < text.length; index++)
      expect(whole(snippet(text, index, 1, 7))).toBe(true);
    for (let budget = 0; budget < 80; budget++)
      expect(whole(truncateBytes(text, budget))).toBe(true);
  });
});

describe("wellFormed", () => {
  it("replaces lone halves and keeps pairs", () => {
    expect(wellFormed("a\ud835b𝑥\udc65")).toBe("a�b𝑥�");
    expect(wellFormedDeep({ hits: [{ snippet: "{\ud835…" }], n: 1 })).toEqual({
      hits: [{ snippet: "{�…" }],
      n: 1,
    });
  });
});
