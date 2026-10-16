import { expect, it, vi } from "vitest";
import type { DatabaseStartupState } from "@zcode/shared";
import { DatabaseStartupAdmission } from "../src/renderer/src/databaseStartupAdmission.js";
const state = (
  startupId: string,
  phase: DatabaseStartupState["phase"] = "ready",
  sequence = 1,
): DatabaseStartupState => ({
  schemaVersion: 1,
  startupId,
  attemptId: startupId + "-attempt",
  sequence,
  phase,
  startedAt: 100,
  updatedAt: 200,
  disk: [],
});
it.each([true, false])("requires the same Host for ready and port, stateFirst=%s", (stateFirst) => {
  const gate = new DatabaseStartupAdmission();
  const port = { close: vi.fn() } as unknown as MessagePort;
  if (stateFirst) {
    gate.acceptState(state("new", "ready", 2));
    expect(gate.takeReadyPort()).toBeUndefined();
    gate.acceptPort({ databaseStartupId: "new" }, port);
  } else {
    gate.acceptPort({ databaseStartupId: "new" }, port);
    expect(gate.takeReadyPort()).toBeUndefined();
    gate.acceptState(state("new", "ready", 2));
  }
  expect(gate.takeReadyPort()).toBe(port);
  expect(gate.takeReadyPort()).toBeUndefined();
});
it("rejects untagged ports, stale snapshots and closes replaced ports", () => {
  const gate = new DatabaseStartupAdmission();
  const old = { close: vi.fn() } as unknown as MessagePort;
  const current = { close: vi.fn() } as unknown as MessagePort;
  gate.acceptPort(null, old);
  expect(old.close).toHaveBeenCalledOnce();
  gate.acceptPort({ databaseStartupId: "a" }, old);
  gate.acceptPort({ databaseStartupId: "b" }, current);
  expect(old.close).toHaveBeenCalledTimes(2);
  gate.acceptState(state("b", "preparing_host_storage", 2));
  expect(gate.acceptState(state("b", "ready", 1))).toBe(false);
  expect(gate.takeReadyPort()).toBeUndefined();
});

it("never combines a previous Host ready with a new Host port", () => {
  const gate = new DatabaseStartupAdmission();
  const port = { close: vi.fn() } as unknown as MessagePort;
  gate.acceptState(state("old"));
  gate.acceptPort({ databaseStartupId: "new" }, port);
  expect(gate.takeReadyPort()).toBeUndefined();
  gate.acceptState(state("new", "preparing_host_storage"));
  expect(gate.takeReadyPort()).toBeUndefined();
  gate.acceptState(state("new", "ready", 2));
  expect(gate.takeReadyPort()).toBe(port);
});
