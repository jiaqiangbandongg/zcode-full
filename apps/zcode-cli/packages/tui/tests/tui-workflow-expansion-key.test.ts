import assert from "node:assert/strict";
import test from "node:test";
import type { KeyEvent } from "@mbears/opentui-core";
import { workflowExpansionActionFor } from "../src/app-keyboard-helpers.js";

// `+` / `-` 是可打印字符且 composer 默认持焦：这组测试钉住"绝不吃掉正常输入"的三层闸门
// （无修饰键 + 草稿为空 + 至少一张 workflow 卡），任何一层松动都会破坏打字。

function key(name: string | undefined, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    ctrl: false,
    meta: false,
    name,
    raw: name ?? "",
    shift: false,
    ...overrides,
  } as KeyEvent;
}

test("bare + with empty draft and cards expands; bare - collapses", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("+"), draftValue: "", hasCards: true }),
    "expand",
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-"), draftValue: "", hasCards: true }),
    "collapse",
  );
});

test("falls back to key.raw when key.name is absent", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key(undefined, { raw: "+" }), draftValue: "", hasCards: true }),
    "expand",
  );
});

test("modified +/- are never claimed (Ctrl/Meta combos belong elsewhere)", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("+", { ctrl: true }), draftValue: "", hasCards: true }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-", { meta: true }), draftValue: "", hasCards: true }),
    undefined,
  );
});

test("a non-empty draft keeps +/- as ordinary typed characters", () => {
  // 粘一段 diff、敲一个 flag、写连字符词——这些都以 +/- 起步或包含它们。
  assert.equal(
    workflowExpansionActionFor({ key: key("+"), draftValue: "diff --git", hasCards: true }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-"), draftValue: "ls ", hasCards: true }),
    undefined,
  );
});

test("no workflow cards means +/- still type, even on an empty draft", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("+"), draftValue: "", hasCards: false }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-"), draftValue: "", hasCards: false }),
    undefined,
  );
});

test("unrelated keys are ignored", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("a"), draftValue: "", hasCards: true }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("enter"), draftValue: "", hasCards: true }),
    undefined,
  );
});
