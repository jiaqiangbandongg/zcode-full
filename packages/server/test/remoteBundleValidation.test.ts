import { describe, expect, it } from "vitest";
import { validateRemoteServerBundle } from "../buildRemoteValidation.js";

describe("remote server bundle validation", () => {
  it("allows bundles that do not depend on undici", () => {
    expect(() =>
      validateRemoteServerBundle({
        bundledInputs: ["src/entry-stdio.ts"],
        source: "console.log('remote server');",
      }),
    ).not.toThrow();
  });

  it("rejects unresolved runtime undici requires", () => {
    expect(() =>
      validateRemoteServerBundle({
        bundledInputs: ["src/entry-stdio.ts"],
        source: 'const undici = require("undici");',
      }),
    ).toThrow(/inline undici/);
  });
});
