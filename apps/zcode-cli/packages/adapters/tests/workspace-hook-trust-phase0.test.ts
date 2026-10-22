import { describe, expect, it } from "vitest";
import { WORKSPACE_HOOK_SCHEMA_FIELDS } from "../../contracts/src/hooks/index.js";
import {
  hookCommandSchema,
  hookMatcherSchema,
  hookProcessSchema,
  hooksSchema,
} from "../src/config/schema.js";

function schemaKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe("workspace hook trust phase 0", () => {
  it("真实 Hook file schema 与 canonical exhaustive lock 保持一致", () => {
    expect(schemaKeys(hooksSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.root);
    expect(schemaKeys(hookMatcherSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.matcher);
    expect(schemaKeys(hooksSchema.shape.events.unwrap())).toEqual(
      WORKSPACE_HOOK_SCHEMA_FIELDS.events,
    );
    expect(schemaKeys(hookProcessSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.process);
    expect(schemaKeys(hookCommandSchema)).toEqual(WORKSPACE_HOOK_SCHEMA_FIELDS.command);
  });
});
