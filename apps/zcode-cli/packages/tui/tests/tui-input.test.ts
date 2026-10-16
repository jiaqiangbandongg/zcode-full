import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import { shouldHandleInputHistoryNavigation } from "../src/app-keyboard.js";
import {
  InputPane,
  INPUT_DEFAULT_EDITOR_ROWS,
  INPUT_PANE_BORDER,
  INPUT_PANE_MAX_HEIGHT,
  INPUT_PANE_MIN_HEIGHT,
  INPUT_PANE_STATUS_ROWS,
  INPUT_PANE_STATUS_SPACER_STYLE,
  INPUT_MAX_EDITOR_ROWS,
  INPUT_MIN_EDITOR_ROWS,
  INPUT_PANE_BORDER_STYLE,
  PROMPT_TEXTAREA_KEY_BINDINGS,
  inputPaneContainerStyle,
  inputPaneEditorRows,
  inputPaneHeight,
  inputPanePlaceholder,
  inputPaneTextareaStyle,
  inputPaneTitle,
  syncTextareaValue,
  type PromptInputEditor,
} from "../src/app-input-pane.js";
import {
  InputActiveStatus,
  InputComposerStatus,
  inputActiveStatusRow,
  inputComposerStatusParts,
  inputComposerStatusRow,
  inputContextUsageBadge,
} from "../src/app-input-status.js";
import { SPINNER_FRAME_INTERVAL_MS, SPINNER_WIDTH, spinnerFrame } from "../src/app-motion.js";
import { palette } from "../src/app-model.js";
import { modelDisplayParts } from "../src/app-model-ref.js";

const TEST_STATUS_PROPS = { model: "default-deepseek/deepseek-v4-pro", thoughtLevel: "max" };

test("prompt textarea binds Enter to submit and Shift+Enter to newline", () => {
  assert.deepEqual(PROMPT_TEXTAREA_KEY_BINDINGS, [
    { name: "return", action: "submit" },
    { name: "linefeed", action: "submit" },
    { name: "return", shift: true, action: "newline" },
    { name: "linefeed", shift: true, action: "newline" },
  ]);
  assert.equal(INPUT_DEFAULT_EDITOR_ROWS, 2);
  assert.equal(INPUT_PANE_STATUS_ROWS, 1);
  assert.deepEqual(INPUT_PANE_STATUS_SPACER_STYLE, { flexGrow: 1, minHeight: 0 });
  assert.equal(INPUT_PANE_BORDER, true);
});

test("sizes prompt textarea from draft content up to six visible rows", () => {
  assert.equal(inputPaneEditorRows("", 40), INPUT_MIN_EDITOR_ROWS);
  assert.equal(inputPaneEditorRows("one\ntwo\nthree", 40), 3);
  assert.equal(inputPaneEditorRows("123456789 123456789 123456789", 10), 3);
  assert.equal(inputPaneEditorRows("1\n2\n3\n4\n5\n6\n7", 40), INPUT_MAX_EDITOR_ROWS);

  const maxContainerStyle = inputPaneContainerStyle(true, INPUT_MAX_EDITOR_ROWS);
  const maxTextareaStyle = inputPaneTextareaStyle(INPUT_MAX_EDITOR_ROWS);

  assert.equal(maxContainerStyle.height, inputPaneHeight(INPUT_MAX_EDITOR_ROWS));
  assert.equal(maxContainerStyle.height, INPUT_PANE_MAX_HEIGHT);
  assert.equal(maxTextareaStyle.height, INPUT_MAX_EDITOR_ROWS);
  assert.equal(maxTextareaStyle.maxHeight, INPUT_MAX_EDITOR_ROWS);
  assert.equal(maxTextareaStyle.minHeight, INPUT_MIN_EDITOR_ROWS);
});

test("uses a complete border for the prompt container", () => {
  const style = inputPaneContainerStyle(true);

  assert.equal(style.border, INPUT_PANE_BORDER);
  assert.equal(style.borderColor, "#7dd3fc");
  assert.equal(style.borderStyle, INPUT_PANE_BORDER_STYLE);
  assert.equal(style.height, INPUT_PANE_MIN_HEIGHT);
});

test("uses localized prompt title and placeholder copy", () => {
  const copy = getZCodeCopy("zh-CN").tui;

  assert.equal(inputPaneTitle(copy), " 输入 ");
  assert.equal(inputPaneTitle(copy, "yolo"), " Yolo ");
  assert.equal(inputPanePlaceholder(copy, false), "输入提示词");
  assert.equal(inputPanePlaceholder(copy, true), "输入内容会排队");
  assert.equal(copy.input.queuedTitle(2), " 队列（2） ");
  assert.equal(copy.input.queuedSubmitHint, "下一次工具调用后提交。");
  assert.equal(copy.input.queuedMore(3), "还有 3 条排队中");
  assert.equal(copy.input.activeStatusHint, "esc to interrupt");
});

test("projects the active status spinner as a braille spinner", () => {
  const firstFrame = "⠋";
  const secondFrame = "⠙";
  const thirdFrame = "⠹";

  assert.equal(Array.from(firstFrame).length, SPINNER_WIDTH);
  assert.equal(spinnerFrame(0), firstFrame);
  assert.equal(spinnerFrame(SPINNER_FRAME_INTERVAL_MS), secondFrame);
  assert.equal(spinnerFrame(SPINNER_FRAME_INTERVAL_MS * 2), thirdFrame);
});

test("splits model refs consistently for composer and sidebar status", () => {
  assert.deepEqual(modelDisplayParts("default-deepseek/deepseek-v4-pro"), {
    model: "deepseek-v4-pro",
    provider: "default-deepseek",
  });
  assert.deepEqual(modelDisplayParts("gateway/openai/gpt-5.5"), {
    model: "openai/gpt-5.5",
    provider: "gateway",
  });
  assert.deepEqual(inputComposerStatusParts("glm-4.6", "max"), {
    model: "glm-4.6",
    provider: "-",
    thought: "max",
  });
});

test("renders model, muted provider, and thought in the composer status row", () => {
  const nodes = collectTextNodes(
    inputComposerStatusRow({
      model: "default-deepseek/deepseek-v4-pro",
      thoughtLevel: "max",
    }),
  );

  assert.equal(nodes.map((node) => node.text).join(""), "deepseek-v4-pro default-deepseek | max");
  assert.deepEqual(nodes.find((node) => node.text === "deepseek-v4-pro")?.style, {
    fg: palette.text,
    flexShrink: 1,
  });
  assert.deepEqual(nodes.find((node) => node.text === " default-deepseek | ")?.style, {
    fg: palette.muted,
  });
  assert.deepEqual(nodes.find((node) => node.text === "max")?.style, {
    fg: palette.warning,
    flexShrink: 0,
  });
});

test("renders the shared composer status row while idle", () => {
  const text = collectTextNodes(
    InputComposerStatus({
      model: "default-deepseek/deepseek-v4-pro",
      thoughtLevel: "max",
    }),
  )
    .map((node) => node.text)
    .join("");

  assert.equal(text, "deepseek-v4-pro default-deepseek | max");
});

test("formats and renders the active status context meter on the right", () => {
  const copy = getZCodeCopy("en-US").tui;
  const contextUsage = { contextUsed: 24_100, contextWindow: 1_000_000 };
  const row = inputActiveStatusRow(copy, undefined, {
    contentWidth: 80,
    contextUsage,
  });
  const nodes = collectTextNodes(row);

  assert.equal(inputContextUsageBadge(contextUsage), "24.1K (2%)");
  assert.equal(inputContextUsageBadge({ contextUsed: 999 }), "999");
  assert.equal(
    inputContextUsageBadge({ contextUsed: 2_000_000, contextWindow: 10_000_000 }),
    "2M (20%)",
  );
  assert.equal(inputContextUsageBadge({ contextWindow: 1_000_000 }), undefined);
  assert.equal(nodes.at(-1)?.text, "24.1K (2%)");
  assert.deepEqual(nodes.at(-1)?.style, {
    fg: palette.muted,
    flexShrink: 0,
  });
  assert.ok(
    collectElementStyles(row).some((style) => style?.flexGrow === 1 && style.minWidth === 1),
  );
});

test("reserves one active status row while idle and empty", () => {
  const copy = getZCodeCopy("en-US").tui;
  const row = InputActiveStatus({ active: false, copy });

  assert.deepEqual(collectTextNodes(row), []);
  assert.ok(collectElementStyles(row).some((style) => style?.height === 1));
});

test("renders the active status outside the composer status row while busy", () => {
  const copy = getZCodeCopy("en-US").tui;
  const frame = spinnerFrame(0);
  const contextUsage = { contextUsed: 11_100, contextWindow: 185_000 };
  const activeNodes = collectTextNodes(inputActiveStatusRow(copy, frame, { contextUsage }));
  const composerText = collectTextNodes(
    InputComposerStatus({
      model: "default-deepseek/deepseek-v4-pro",
      thoughtLevel: "max",
    }),
  )
    .map((node) => node.text)
    .join("");

  assert.equal(
    activeNodes.map((node) => node.text).join(""),
    `${frame} esc to interrupt11.1K (6%)`,
  );
  assert.equal(composerText, "deepseek-v4-pro default-deepseek | max");
  assert.equal(
    collectTextNodes(InputActiveStatus({ active: false, contextUsage, copy })!).at(-1)?.text,
    "11.1K (6%)",
  );
  assert.deepEqual(activeNodes.find((node) => node.text === frame)?.style, {
    fg: palette.accent,
    flexShrink: 0,
    width: SPINNER_WIDTH,
  });
});

test("syncs external draft replacement into the textarea buffer", () => {
  let plainText = "old draft";
  let cursorMoved = 0;

  const changed = syncTextareaValue(
    {
      get plainText() {
        return plainText;
      },
      gotoBufferEnd: () => {
        cursorMoved += 1;
      },
      setText: (value) => {
        plainText = value;
      },
    },
    "new draft",
  );

  assert.equal(changed, true);
  assert.equal(plainText, "new draft");
  assert.equal(cursorMoved, 1);
});

test("does not resync an unchanged textarea draft", () => {
  const changed = syncTextareaValue(
    {
      plainText: "same draft",
      gotoBufferEnd: () => {
        throw new Error("cursor should not move when the draft is unchanged");
      },
      setText: () => {
        throw new Error("text should not be reset when the draft is unchanged");
      },
    },
    "same draft",
  );

  assert.equal(changed, false);
});

test("captures history navigation only when the editor is not actively drafting", () => {
  assert.equal(
    shouldHandleInputHistoryNavigation({
      draftValue: "",
      inputHistoryActive: false,
    }),
    true,
  );
  assert.equal(
    shouldHandleInputHistoryNavigation({
      draftValue: "line one\nline two",
      inputHistoryActive: false,
    }),
    false,
  );
  assert.equal(
    shouldHandleInputHistoryNavigation({
      draftValue: "recalled draft",
      inputHistoryActive: true,
    }),
    true,
  );
});

test("Shift+Enter inserts a newline while Enter submits the textarea draft", async () => {
  const inputs: string[] = [];
  const submitted: string[] = [];
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  await act(async () => {
    view = await testRender(
      React.createElement(InputPane, {
        busy: false,
        focused: true,
        ...TEST_STATUS_PROPS,
        onInput: (value) => {
          inputs.push(value);
        },
        onSubmit: (value) => {
          submitted.push(value);
        },
        resetCursorToEndVersion: 0,
        value: "",
      }),
      {
        height: 12,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 50,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("hello");
      view.mockInput.pressEnter({ shift: true });
      await view.mockInput.typeText("world");
      view.mockInput.pressEnter();
      await view.renderOnce();
    });

    assert.equal(inputs.at(-1), "hello\nworld");
    assert.deepEqual(submitted, ["hello\nworld"]);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("keeps the shared prompt editor ref live after title updates", async () => {
  const editorRef = { current: null } as React.MutableRefObject<PromptInputEditor | null>;
  let setMode: React.Dispatch<React.SetStateAction<string>> | undefined;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  function Harness(): React.ReactElement {
    const [mode, applyMode] = React.useState("build");
    setMode = applyMode;
    return React.createElement(InputPane, {
      busy: false,
      editorRef,
      focused: true,
      mode,
      ...TEST_STATUS_PROPS,
      onInput: () => undefined,
      onSubmit: () => undefined,
      resetCursorToEndVersion: 0,
      value: "",
    });
  }

  await act(async () => {
    view = await testRender(React.createElement(Harness), {
      height: 12,
      kittyKeyboard: true,
      otherModifiersMode: true,
      width: 50,
    });
    await view.renderOnce();
  });

  try {
    assert.ok(editorRef.current);
    assert.ok(setMode);

    await act(async () => {
      setMode?.("yolo");
      await view?.renderOnce();
    });

    assert.doesNotThrow(() => editorRef.current?.cursorOffset);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

function collectElementStyles(node: unknown): Array<Record<string, unknown> | undefined> {
  if (Array.isArray(node)) return node.flatMap(collectElementStyles);
  if (typeof node !== "object" || node === null || !("props" in node)) return [];

  const element = node as { props?: { children?: unknown; style?: unknown } };
  const style = element.props?.style;
  const styleValue =
    style !== null && typeof style === "object" ? (style as Record<string, unknown>) : undefined;
  return [styleValue, ...collectElementStyles(element.props?.children)];
}

function collectTextNodes(node: unknown): Array<{ style?: unknown; text: string }> {
  if (Array.isArray(node)) return node.flatMap(collectTextNodes);
  if (typeof node !== "object" || node === null || !("props" in node)) return [];

  const element = node as { props?: { children?: unknown; style?: unknown }; type?: unknown };
  const children = element.props?.children;
  const current =
    element.type === "text" && typeof children === "string"
      ? [{ style: element.props?.style, text: children }]
      : [];
  return [...current, ...collectTextNodes(children)];
}
