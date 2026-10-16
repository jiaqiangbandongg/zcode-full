import { describe, expect, it } from "vitest";
import { uuidv7 } from "@zcode/shared";
import { uuidv7 as commandUuidv7 } from "../src/v4/commandFactory.js";

describe("shared main-turn UUID v7", () => {
  it("uses the same generator for renderer commands and runtime wake inputs", () => {
    expect(commandUuidv7).toBe(uuidv7);
    const now = 1_788_749_627_422;
    const ids = Array.from({ length: 100 }, () => uuidv7(now));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(now);
      expect(id < uuidv7(now + 1)).toBe(true);
    }
  });
});
