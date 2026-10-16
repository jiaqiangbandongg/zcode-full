import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolveStorageRoots } from "../src/storage/adapters/rootsResolver.js";

describe("resolveStorageRoots", () => {
  it("returns only the home root when the data base dir is the home dir", () => {
    expect(resolveStorageRoots({ homeDir: "/Users/u", dataBaseDir: "/Users/u/" })).toEqual([
      { id: "home", path: join(resolve("/Users/u"), ".zcode"), hasCustomDataBaseDir: false },
    ]);
  });

  it("adds the custom data base dir root and flags the home root as having a stale v2 copy", () => {
    expect(
      resolveStorageRoots({ homeDir: "/Users/u", dataBaseDir: "/Volumes/Data/zcode" }),
    ).toEqual([
      { id: "home", path: join(resolve("/Users/u"), ".zcode"), hasCustomDataBaseDir: true },
      {
        id: "dataBaseDir",
        path: join(resolve("/Volumes/Data/zcode"), ".zcode"),
        hasCustomDataBaseDir: true,
      },
    ]);
  });
});
