import { describe, expect, it } from "vitest";
import {
  ModelOptionMapError,
  applyOrderedJsonMergePatches,
  compileModelOptionMaps,
  type NamedJsonMergePatch,
} from "../src/index.js";

describe("ordered JSON Merge Patch", () => {
  it("compiles once and applies reasoning before max output", () => {
    const maps = compileModelOptionMaps({
      reasoningLevel: { map: "{'reasoning': {'effort': reasoningLevel}}" },
      maxOutputTokens: { map: "{'max_output_tokens': maxOutputTokens}" },
    });

    expect(
      maps.apply({ model: "example" }, { reasoningLevel: "high", maxOutputTokens: 32_000 }),
    ).toEqual({
      model: "example",
      reasoning: { effort: "high" },
      max_output_tokens: 32_000,
    });
  });

  it("fails closed when a declared reasoning map has no effective value", () => {
    const maps = compileModelOptionMaps({
      reasoningLevel: { map: "{'reasoning_effort': reasoningLevel}" },
      maxOutputTokens: { map: "{'max_completion_tokens': maxOutputTokens}" },
    });

    expect(() => maps.apply({}, { maxOutputTokens: 32_000 })).toThrow(
      "reasoningLevel requires an effective value",
    );
  });
  it("implements RFC 7396 add, replace, recursive merge, array replace and null delete", () => {
    const result = applyOrderedJsonMergePatches(
      {
        keep: true,
        nested: { remove: 1, replace: 2 },
        array: [1, 2],
      },
      [
        {
          option: "reasoningLevel",
          patch: {
            added: "yes",
            array: [3],
            nested: { remove: null, replace: 3 },
          },
        },
      ],
    );

    expect(result).toEqual({
      added: "yes",
      array: [3],
      keep: true,
      nested: { replace: 3 },
    });
  });

  it("allows sibling leaf writes from ordered options", () => {
    expect(
      applyOrderedJsonMergePatches({}, [
        { option: "reasoningLevel", patch: { reasoning: { effort: "high" } } },
        { option: "maxOutputTokens", patch: { reasoning: { max_tokens: 32000 } } },
      ]),
    ).toEqual({ reasoning: { effort: "high", max_tokens: 32000 } });
  });

  it.each<{ patches: NamedJsonMergePatch[] }>([
    {
      patches: [
        { option: "reasoningLevel", patch: { value: 1 } },
        { option: "maxOutputTokens", patch: { value: 2 } },
      ],
    },
    {
      patches: [
        { option: "reasoningLevel", patch: { reasoning: null } },
        { option: "maxOutputTokens", patch: { reasoning: { max_tokens: 2 } } },
      ],
    },
    {
      patches: [
        { option: "reasoningLevel", patch: { reasoning: { effort: "high" } } },
        { option: "maxOutputTokens", patch: { reasoning: [] } },
      ],
    },
  ])("rejects overlapping option write paths", ({ patches }) => {
    expect(() => applyOrderedJsonMergePatches({}, patches)).toThrow(ModelOptionMapError);
    expect(() => applyOrderedJsonMergePatches({}, patches)).toThrow("conflicting JSON path");
  });

  it("does not mutate the source body or patches", () => {
    const body = { nested: { before: true } };
    const patch = { nested: { after: true } };
    const result = applyOrderedJsonMergePatches(body, [{ option: "reasoningLevel", patch }]);

    expect(result).toEqual({ nested: { after: true, before: true } });
    expect(body).toEqual({ nested: { before: true } });
    expect(patch).toEqual({ nested: { after: true } });
  });
});
