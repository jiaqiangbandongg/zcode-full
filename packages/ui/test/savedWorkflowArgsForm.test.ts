// 已保存工作流实参表单的纯函数（docs/dynamic-workflow/launch.md「The launch dialog」「元数据编辑」）。
import { describe, expect, it } from "vitest";
import {
  argsDeclarationToRows,
  buildSavedWorkflowArgFields,
  collectSavedWorkflowArgs,
  formatSavedWorkflowArgValue,
  parseSavedWorkflowArgField,
  rowsToArgsDeclaration,
  type SavedWorkflowArgField,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";

function field(overrides: Partial<SavedWorkflowArgField>): SavedWorkflowArgField {
  return {
    name: "x",
    type: "string",
    required: false,
    hasDefault: false,
    value: "",
    ...overrides,
  };
}

describe("buildSavedWorkflowArgFields", () => {
  it("按声明铺成字段并回填默认值文本", () => {
    const fields = buildSavedWorkflowArgFields({
      branch: { type: "string", required: true, description: "目标分支" },
      count: { type: "number", default: 3 },
      dry: { type: "boolean", default: true },
      extra: { type: "json", default: { a: 1 } },
      plain: { type: "boolean" },
    });
    expect(fields.map((entry) => entry.name)).toEqual(["branch", "count", "dry", "extra", "plain"]);
    expect(fields[0]).toMatchObject({
      required: true,
      hasDefault: false,
      value: "",
      description: "目标分支",
    });
    expect(fields[1]).toMatchObject({ hasDefault: true, value: "3" });
    expect(fields[2]).toMatchObject({ value: "true" });
    expect(fields[3]?.value).toBe(JSON.stringify({ a: 1 }, null, 2));
    // boolean 永远有值：无默认值按 false。
    expect(fields[4]?.value).toBe("false");
    expect(buildSavedWorkflowArgFields(undefined)).toEqual([]);
  });

  it("formatSavedWorkflowArgValue 对 json 类型的字符串默认值保留引号", () => {
    expect(formatSavedWorkflowArgValue("json", "text")).toBe('"text"');
    expect(formatSavedWorkflowArgValue("string", 42)).toBe("42");
    expect(formatSavedWorkflowArgValue("boolean", undefined)).toBe("false");
  });
});

describe("parseSavedWorkflowArgField / collectSavedWorkflowArgs", () => {
  it("空文本对非必填即缺席；必填无默认值才报 required", () => {
    expect(parseSavedWorkflowArgField(field({ value: "" }))).toEqual({ ok: true, omitted: true });
    expect(parseSavedWorkflowArgField(field({ value: "", required: true }))).toEqual({
      ok: false,
      error: "required",
    });
    // 必填但有默认值：留空交给服务端回填，不算错误。
    expect(
      parseSavedWorkflowArgField(field({ value: "", required: true, hasDefault: true })),
    ).toEqual({
      ok: true,
      omitted: true,
    });
  });

  it("按类型解析：number 拒 NaN/Infinity，json 拒坏文本，boolean 永远有值", () => {
    expect(parseSavedWorkflowArgField(field({ type: "number", value: " 12.5 " }))).toEqual({
      ok: true,
      omitted: false,
      value: 12.5,
    });
    expect(parseSavedWorkflowArgField(field({ type: "number", value: "abc" }))).toEqual({
      ok: false,
      error: "invalid_number",
    });
    expect(parseSavedWorkflowArgField(field({ type: "number", value: "Infinity" }))).toEqual({
      ok: false,
      error: "invalid_number",
    });
    expect(parseSavedWorkflowArgField(field({ type: "json", value: '{"a":[1]}' }))).toEqual({
      ok: true,
      omitted: false,
      value: { a: [1] },
    });
    expect(parseSavedWorkflowArgField(field({ type: "json", value: "{a" }))).toEqual({
      ok: false,
      error: "invalid_json",
    });
    expect(parseSavedWorkflowArgField(field({ type: "boolean", value: "true" }))).toEqual({
      ok: true,
      omitted: false,
      value: true,
    });
  });

  it("整张表单一次收齐全部错误，而不是逐个报", () => {
    const result = collectSavedWorkflowArgs([
      field({ name: "branch", required: true }),
      field({ name: "count", type: "number", value: "x" }),
      field({ name: "dry", type: "boolean", value: "false" }),
    ]);
    expect(result).toEqual({ ok: false, errors: { branch: "required", count: "invalid_number" } });
    const ok = collectSavedWorkflowArgs([
      field({ name: "branch", value: "main" }),
      field({ name: "note", value: "" }),
      field({ name: "dry", type: "boolean", value: "false" }),
    ]);
    expect(ok).toEqual({ ok: true, args: { branch: "main", dry: false } });
  });
});

describe("argsDeclarationToRows / rowsToArgsDeclaration", () => {
  it("声明 ↔ 表行往返保持语义（空表回 undefined）", () => {
    const declaration = {
      branch: { type: "string" as const, required: true, description: "目标分支" },
      count: { type: "number" as const, default: 3 },
      dry: { type: "boolean" as const, default: false },
      extra: { type: "json" as const, default: { a: 1 } },
    };
    const rows = argsDeclarationToRows(declaration);
    expect(rows.map((row) => row.key)).toEqual(["0:branch", "1:count", "2:dry", "3:extra"]);
    expect(rows[2]?.defaultText).toBe("false");
    expect(rowsToArgsDeclaration(rows)).toEqual({ ok: true, args: declaration });
    expect(rowsToArgsDeclaration([])).toEqual({ ok: true, args: undefined });
    expect(argsDeclarationToRows(undefined)).toEqual([]);
  });

  it("空名字 / 重名 / 默认值类型不符各自有错误码", () => {
    const rows = argsDeclarationToRows({ a: { type: "number" } });
    const result = rowsToArgsDeclaration([
      { ...rows[0]!, defaultText: "abc" },
      {
        key: "new:1",
        name: "  ",
        type: "string",
        required: false,
        defaultText: "",
        description: "",
      },
      {
        key: "new:2",
        name: "dup",
        type: "string",
        required: false,
        defaultText: "",
        description: "",
      },
      {
        key: "new:3",
        name: "dup",
        type: "boolean",
        required: false,
        defaultText: "maybe",
        description: "",
      },
    ]);
    expect(result).toEqual({
      ok: false,
      errors: { "0:a": "invalid_default", "new:1": "empty_name", "new:3": "duplicate_name" },
    });
  });

  it("修剪说明、只在勾选时写 required、默认值缺席时不写 default 键", () => {
    const result = rowsToArgsDeclaration([
      {
        key: "k",
        name: " name ",
        type: "string",
        required: false,
        defaultText: "",
        description: "  ",
      },
    ]);
    expect(result).toEqual({ ok: true, args: { name: { type: "string" } } });
  });
});
