import { describe, expect, it } from "vitest";
import { dirname, join, parse, resolve } from "node:path";
import { getGenUiOutputDirectory } from "./genUiPaths.js";

const scope = { workspacePath: resolve("workspace"), sessionId: "session" };
const root = resolve("user-data", "visualizations");
describe("Gen UI output directory", () => {
  it("isolates sessions and workspace identities with a stable safe path", () => {
    const directory = getGenUiOutputDirectory(root, scope);
    expect(directory).toMatch(/[a-f0-9]{64}$/u);
    expect(getGenUiOutputDirectory(root, { ...scope })).toBe(directory);
    expect(getGenUiOutputDirectory(root, { ...scope, sessionId: "../other" })).not.toBe(directory);
    expect(
      getGenUiOutputDirectory(root, { ...scope, workspaceIdentity: "ssh:first:/workspace" }),
    ).not.toBe(directory);
    const remote = { ...scope, workspaceIdentity: "ssh:first:/workspace" };
    expect(getGenUiOutputDirectory(root, { ...remote, workspacePath: resolve("other-path") })).toBe(
      getGenUiOutputDirectory(root, remote),
    );
    expect(
      getGenUiOutputDirectory(root, { ...remote, workspaceIdentity: "ssh:second:/workspace" }),
    ).not.toBe(getGenUiOutputDirectory(root, remote));
  });
  it.each([undefined, "ssh:executor:/home/dev"])(
    "allows the fixed output root within or equal to the workspace (%s)",
    (workspaceIdentity) => {
      for (const outputRoot of [scope.workspacePath, join(scope.workspacePath, ".zcode")]) {
        const directory = getGenUiOutputDirectory(outputRoot, { ...scope, workspaceIdentity });
        expect(dirname(directory)).toBe(outputRoot);
        expect(directory).not.toBe(outputRoot);
      }
      expect(
        dirname(getGenUiOutputDirectory(root, { ...scope, workspacePath: parse(root).root })),
      ).toBe(root);
    },
  );
  it("rejects relative roots and workspace paths", () => {
    expect(() => getGenUiOutputDirectory("relative", scope)).toThrow();
    expect(() => getGenUiOutputDirectory(root, { ...scope, workspacePath: "relative" })).toThrow();
  });
});
