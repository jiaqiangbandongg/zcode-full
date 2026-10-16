import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchEntry,
} from "../src/file/workspaceFileMentionFilter.js";

function entry(
  name: string,
  type: WorkspaceFileSearchEntry["type"],
  relativePath = name,
): WorkspaceFileSearchEntry {
  return {
    name,
    path: `/workspace/${relativePath}`,
    relativePath,
    type,
  };
}

describe("defaultWorkspaceFileSearchFilter", () => {
  it("traverses ordinary hidden directories without including the directory candidate", () => {
    expect(defaultWorkspaceFileSearchFilter.evaluate(entry(".github", "directory"))).toEqual({
      include: false,
      traverse: true,
    });
  });

  it("excludes version control and dependency directories with their descendants", () => {
    for (const name of [".git", ".hg", ".svn", "node_modules"]) {
      expect(defaultWorkspaceFileSearchFilter.evaluate(entry(name, "directory"))).toEqual({
        include: false,
        traverse: false,
      });
    }
  });

  it("includes ordinary hidden files but excludes env files by default", () => {
    expect(defaultWorkspaceFileSearchFilter.evaluate(entry(".gitignore", "file"))).toEqual({
      include: true,
      traverse: false,
    });
    for (const name of [".env", ".env.local", ".ENV.PRODUCTION"]) {
      expect(defaultWorkspaceFileSearchFilter.evaluate(entry(name, "file"))).toEqual({
        include: false,
        traverse: false,
      });
    }
  });

  it("includes user-maintained directories removed from the broad default blacklist", () => {
    for (const name of [
      "vendor",
      "env",
      "dist",
      "build",
      "out",
      "target",
      "bin",
      "obj",
      "classes",
      "_build",
      "deps",
      "dist-newstyle",
      "renv",
    ]) {
      expect(defaultWorkspaceFileSearchFilter.evaluate(entry(name, "directory"))).toEqual({
        include: true,
        traverse: true,
      });
    }
  });

  it("includes source maps and minified assets removed from the default blacklist", () => {
    for (const name of ["bundle.js.map", "app.min.js", "style.min.css"]) {
      expect(defaultWorkspaceFileSearchFilter.evaluate(entry(name, "file"))).toEqual({
        include: true,
        traverse: false,
      });
    }
  });

  it("continues to exclude compiled and binary artifacts by default", () => {
    for (const name of ["module.pyc", "Main.class", "addon.node", "app.exe", "lib.dll"]) {
      expect(defaultWorkspaceFileSearchFilter.evaluate(entry(name, "file"))).toEqual({
        include: false,
        traverse: false,
      });
    }
  });
});
