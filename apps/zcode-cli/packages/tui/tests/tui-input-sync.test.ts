import assert from "node:assert/strict";
import test from "node:test";
import { shouldEmitTextareaInput } from "../src/app-input-pane.js";

test("ignores controlled textarea sync echoes", () => {
  assert.equal(shouldEmitTextareaInput("restored prompt", "restored prompt"), false);
  assert.equal(shouldEmitTextareaInput("restored prompt", "restored prompt plus edit"), true);
});
