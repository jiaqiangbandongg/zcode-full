import { describe, expect, it } from "vitest";
import {
  RestrictedCelError,
  compileModelOptionMap,
  compileRestrictedCel,
  tokenizeRestrictedCel,
} from "../src/index.js";

describe("restricted CEL", () => {
  it("tokenizes supported literals and operators with stable offsets", () => {
    expect(tokenizeRestrictedCel("value >= 10 ? {'ok': true} : null").slice(0, 4)).toMatchObject([
      { kind: "identifier", offset: 0, value: "value" },
      { kind: "operator", offset: 6, value: ">=" },
      { kind: "number", offset: 9, value: "10" },
      { kind: "punctuation", offset: 12, value: "?" },
    ]);
  });

  it("evaluates nested objects, arrays, arithmetic and ternaries", () => {
    const program = compileRestrictedCel(
      "reasoningLevel == 'low' ? {'thinking': {'budget_tokens': 1024, 'enabled': true}, 'tags': [reasoningLevel, 2 + 3 * 4]} : {'thinking': null}",
      "reasoningLevel",
    );

    expect(program.evaluate("low")).toEqual({
      tags: ["low", 14],
      thinking: { budget_tokens: 1024, enabled: true },
    });
    expect(program.evaluate("off")).toEqual({ thinking: null });
  });

  it("implements CEL precedence, short circuiting and string concatenation", () => {
    expect(compileRestrictedCel("false && (1 / 0 > 0)", "reasoningLevel").evaluate(0)).toBe(false);
    expect(compileRestrictedCel("true || (1 / 0 > 0)", "reasoningLevel").evaluate(0)).toBe(true);
    expect(
      compileRestrictedCel("!(1 + 2 * 3 == 7) ? 'bad' : 'o' + 'k'", "reasoningLevel").evaluate(0),
    ).toBe("ok");
  });

  it("caches immutable programs without sharing execution state", () => {
    const first = compileRestrictedCel("{'selected': reasoningLevel}", "reasoningLevel");
    const second = compileRestrictedCel("{'selected': reasoningLevel}", "reasoningLevel");

    expect(second).toBe(first);
    expect(first.evaluate("first")).toEqual({ selected: "first" });
    expect(second.evaluate("second")).toEqual({ selected: "second" });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("does not reuse a program compiled for another option variable", () => {
    const source = "{'selected': reasoningLevel}";

    expect(compileModelOptionMap(source, "reasoningLevel").evaluate("high")).toEqual({
      selected: "high",
    });
    expect(() => compileModelOptionMap(source, "maxOutputTokens")).toThrow(
      'unknown identifier "reasoningLevel"',
    );
  });

  it.each([
    ["unknown", "unknown identifier"],
    ["reasoningLevel.field", "member access"],
    ["fn(value)", "function calls"],
    ["reasoningLevel.map(x, x)", "member access"],
    ["[x for x in value]", "unknown identifier"],
    ["reasoningLevel trailing", "unexpected token"],
  ])("rejects unsupported expression %s", (source, reason) => {
    expect(() => compileRestrictedCel(source, "reasoningLevel")).toThrowError(RestrictedCelError);
    expect(() => compileRestrictedCel(source, "reasoningLevel")).toThrow(reason);
  });

  it.each(["9007199254740992", "1 / 0", "0 / 0", "1e309"])(
    "rejects non JSON-safe number %s",
    (source) => {
      expect(() => compileRestrictedCel(source, "reasoningLevel").evaluate(0)).toThrow(
        RestrictedCelError,
      );
    },
  );

  it("rejects non JSON-safe runtime input and duplicate object keys", () => {
    expect(() =>
      compileRestrictedCel("reasoningLevel", "reasoningLevel").evaluate(Number.NaN),
    ).toThrow("JSON-safe");
    expect(() =>
      compileRestrictedCel("reasoningLevel", "reasoningLevel").evaluate(true as never),
    ).toThrow("string or number");
    expect(() => compileRestrictedCel("{'a': 1, 'a': 2}", "reasoningLevel")).toThrow(
      "duplicate object key",
    );
  });

  it("requires model option maps to return a JSON object patch", () => {
    expect(
      compileModelOptionMap("{'max_tokens': maxOutputTokens}", "maxOutputTokens").evaluate(1024),
    ).toEqual({
      max_tokens: 1024,
    });
    expect(() => compileModelOptionMap("maxOutputTokens", "maxOutputTokens")).toThrow(
      "must return a JSON object",
    );
    expect(() => compileModelOptionMap("[maxOutputTokens]", "maxOutputTokens")).toThrow(
      "must return a JSON object",
    );
    expect(() =>
      compileModelOptionMap("maxOutputTokens == 1 ? {'ok': true} : null", "maxOutputTokens"),
    ).toThrow("must return a JSON object");
    expect(() =>
      compileModelOptionMap(
        "maxOutputTokens == 1 ? {'selected': maxOutputTokens} : {'fallback': true}",
        "maxOutputTokens",
      ),
    ).not.toThrow();
    expect(() => compileModelOptionMap("{'max_tokens': value}", "maxOutputTokens")).toThrow(
      'unknown identifier "value"',
    );
  });

  it("reports a stable source offset", () => {
    try {
      compileRestrictedCel("reasoningLevel ? {'ok': true} :", "reasoningLevel");
      throw new Error("expected compile failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RestrictedCelError);
      expect((error as RestrictedCelError).offset).toBe(31);
      expect((error as Error).message).toContain("offset 31");
    }
  });
});
