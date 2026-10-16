import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { InternalChannels, type DatabaseStartupState } from "@zcode/shared";
const ipc = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn() }));
const telemetry = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ ipcMain: ipc }));
vi.mock("../src/main/databaseStartupTelemetry.js", () => ({
  reportDatabaseStartupState: telemetry,
}));
import {
  bindDatabaseStartupRelay,
  onLocalDatabaseStartupReady,
  getDatabaseStartupPortPayload,
} from "../src/main/databaseStartupRelay.js";

it("serves refresh snapshots, scopes retry to its window, and preserves disk observations on Host exit", () => {
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  });
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const relay = bindDatabaseStartupRelay(win as never, child as never, "relay-startup");
  const state: DatabaseStartupState = {
    schemaVersion: 1,
    startupId: "relay-startup",
    attemptId: "relay-attempt",
    sequence: 2,
    startedAt: 100,
    updatedAt: 200,
    phase: "preparing_session_storage",
    disk: [
      {
        scopeId: "volume",
        observedAvailableDropPeakBytes: 800,
        minAvailableBytes: 200,
        quality: "complete",
        sampledAt: 200,
      },
    ],
  };
  relay.receive(state);
  relay.receive({ ...state, sequence: 1, phase: "ready" });
  expect(win.webContents.send).toHaveBeenCalledTimes(1);
  const control = ipc.on.mock.calls.at(-1)![1];
  control({ sender: {} }, { action: "retry", attemptId: state.attemptId });
  expect(child.postMessage).not.toHaveBeenCalled();
  control({ sender: win.webContents }, { action: "snapshot" });
  expect(win.webContents.send).toHaveBeenCalledTimes(2);
  expect(child.postMessage.mock.calls[0]?.[0].control.action).toBe("snapshot");
  child.emit("exit", 1);
  expect(telemetry.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "failed",
    errorCode: "transport_closed",
    disk: state.disk,
  });
  const count = child.postMessage.mock.calls.length;
  control({ sender: win.webContents }, { action: "retry", attemptId: state.attemptId });
  expect(child.postMessage).toHaveBeenCalledTimes(count);
  win.emit("closed");
  expect(ipc.removeListener).toHaveBeenCalledWith(InternalChannels.DatabaseStartupControl, control);
});

it("starts the existing scheduler only after a Host reports ready, once across windows", () => {
  const ready = vi.fn();
  onLocalDatabaseStartupReady(ready);
  expect(ready).not.toHaveBeenCalled();
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  });
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const relay = bindDatabaseStartupRelay(win as never, child as never, "relay-ready");
  relay.receive({
    schemaVersion: 1,
    startupId: "relay-ready",
    attemptId: "ready",
    sequence: 1,
    phase: "ready",
    startedAt: 100,
    updatedAt: 200,
    disk: [],
  });
  expect(ready).toHaveBeenCalledTimes(1);
  child.emit("exit", 0);
  win.emit("closed");
});

it("replaces the previous Host binding and never replays ready after exit", () => {
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  });
  const old = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const oldRelay = bindDatabaseStartupRelay(win as never, old as never, "old-host");
  const ready: DatabaseStartupState = {
    schemaVersion: 1,
    startupId: "old-host",
    attemptId: "old-attempt",
    sequence: 1,
    phase: "ready",
    startedAt: 100,
    updatedAt: 200,
    disk: [],
  };
  oldRelay.receive(ready);
  old.emit("exit", 1);
  const oldControl = ipc.on.mock.calls.at(-1)![1];
  oldControl({ sender: win.webContents }, { action: "snapshot" });
  expect(win.webContents.send.mock.calls.at(-1)![1].phase).toBe("failed");
  expect(getDatabaseStartupPortPayload(old as never)).toBeUndefined();
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const next = bindDatabaseStartupRelay(win as never, child as never, "new-host");
  expect(ipc.removeListener).toHaveBeenCalledWith(
    InternalChannels.DatabaseStartupControl,
    oldControl,
  );
  expect(getDatabaseStartupPortPayload(child as never)).toEqual({ databaseStartupId: "new-host" });
  win.webContents.send.mockClear();
  oldControl({ sender: win.webContents }, { action: "snapshot" });
  oldRelay.receive({ ...ready, sequence: 100 });
  next.receive({ ...ready, sequence: 101 });
  expect(win.webContents.send).not.toHaveBeenCalled();
  next.receive({ ...ready, startupId: "new-host", sequence: 1 });
  expect(win.webContents.send).toHaveBeenCalledTimes(1);
  win.emit("closed");
});
