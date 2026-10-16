import assert from "node:assert/strict";
import test from "node:test";
import {
  CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
  createCtrlCExitGuard,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
} from "../src/app-keyboard.js";

test("requires two consecutive Ctrl-C presses inside the confirmation window", () => {
  const guard = createCtrlCExitGuard();
  const firstPressAtMs = 1_000;

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs), "show_prompt");
  assert.equal(
    resolveCtrlCExitIntent(guard, firstPressAtMs + CTRL_C_EXIT_CONFIRMATION_WINDOW_MS),
    "confirm_exit",
  );
  assert.equal(guard.lastPressAtMs, undefined);
});

test("restarts Ctrl-C confirmation after the timeout", () => {
  const guard = createCtrlCExitGuard();
  const firstPressAtMs = 1_000;
  const afterTimeoutMs = firstPressAtMs + CTRL_C_EXIT_CONFIRMATION_WINDOW_MS + 1;

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs), "show_prompt");
  assert.equal(resolveCtrlCExitIntent(guard, afterTimeoutMs), "show_prompt");
  assert.equal(guard.lastPressAtMs, afterTimeoutMs);
});

test("resets Ctrl-C confirmation when another key is handled", () => {
  const guard = createCtrlCExitGuard();
  const firstPressAtMs = 1_000;

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs), "show_prompt");
  resetCtrlCExitGuard(guard);

  assert.equal(resolveCtrlCExitIntent(guard, firstPressAtMs + 1), "show_prompt");
});
