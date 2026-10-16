import { describe, expect, it, vi } from "vitest";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import { readBackgroundBashOutputFromOwner as readOutput } from "../src/zcode-protocol/background-work-owner.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const output: BackgroundBashOutputResult = {
  kind: "output",
  workId: "work",
  status: "running",
  output: "child output",
  truncated: false,
  outputPath: "/output.log",
};
const unavailable: BackgroundBashOutputResult = { kind: "unavailable", workId: "work" };

function setup(childResult?: BackgroundBashOutputResult) {
  const rootRead = vi.fn(async (_workId: string, sessionId: string) =>
    sessionId === "child" ? output : unavailable,
  );
  const childRead = vi.fn(async () => childResult ?? unavailable);
  const getSession = vi.fn(async (id: string) =>
    id === "child" || id === "sibling" ? { parentID: "root" } : undefined,
  );
  const sessions = new Map<string, unknown>([
    ["root", { app: { readBackgroundBashOutput: rootRead } }],
  ]);
  if (childResult) sessions.set("child", { app: { readBackgroundBashOutput: childRead } });
  const context = {
    sessions,
    deps: { sessionStore: { getSession } },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, rootRead, childRead, getSession };
}

describe("background work owner", () => {
  it("queries the existing ancestor with the original child session without cold resume", async () => {
    const { context, rootRead, getSession } = setup();
    expect(await readOutput(context, "child", "work")).toEqual(output);
    expect(rootRead).toHaveBeenCalledExactlyOnceWith("work", "child");
    expect(getSession.mock.calls.map(([id]) => id)).toEqual(["child"]);
  });

  it("finds the old task in the ancestor after a resumed child gets a fresh adapter", async () => {
    const { context, rootRead, childRead } = setup(unavailable);
    expect(await readOutput(context, "child", "work")).toEqual(output);
    expect(childRead).toHaveBeenCalledExactlyOnceWith("work", "child");
    expect(rootRead).toHaveBeenCalledExactlyOnceWith("work", "child");
  });

  it("returns a task owned by the current child without consulting ancestors", async () => {
    const { context, rootRead, getSession } = setup(output);
    expect(await readOutput(context, "child", "work")).toEqual(output);
    expect(rootRead).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "read_failed", workId: "work", code: "EACCES" },
    { kind: "unsupported", workId: "work" },
  ] as const)("preserves $kind without falling back to another adapter", async (result) => {
    const { context, rootRead, getSession } = setup(result);
    expect(await readOutput(context, "child", "work")).toEqual(result);
    expect(rootRead).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not read a sibling task through a shared ancestor", async () => {
    const { context, rootRead } = setup();
    expect(await readOutput(context, "sibling", "work")).toEqual(unavailable);
    expect(rootRead).toHaveBeenCalledExactlyOnceWith("work", "sibling");
  });

  it("returns unavailable for missing or cyclic ancestry", async () => {
    const { context, getSession } = setup();
    getSession.mockImplementation(async (id) => (id === "cycle" ? { parentID: id } : undefined));
    expect(await readOutput(context, "missing", "work")).toEqual(unavailable);
    expect(await readOutput(context, "cycle", "work")).toEqual(unavailable);
    expect(getSession.mock.calls.map(([id]) => id)).toEqual(["missing", "cycle"]);
  });
});
