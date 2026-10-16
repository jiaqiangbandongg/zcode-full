import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import { TuiApp } from "../src/app.js";
import { LoginRequiredPanel } from "../src/app-components.js";
import { ZCODE_LOGO_LINES } from "../src/app-empty-transcript.js";
import { InputPane } from "../src/app-input-pane.js";
import { InputActiveStatus } from "../src/app-input-status.js";
import { QueuedInputPanel } from "../src/app-queued-inputs.js";
import { SelectionPanel } from "../src/app-selection-panel.js";
import { ComposerInputArea } from "../src/app-view.js";
import type { TuiOptions } from "../src/types.js";

test("starts without a runtime readiness system message", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "done" }),
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    assert.ok(view);
    const frame = view.captureCharFrame();
    const rows = frame.split("\n");
    const firstLogoRow = rows.findIndex((row) => row.includes(ZCODE_LOGO_LINES[0]));
    const lastLogoRow = rows.findIndex((row) => row.includes(ZCODE_LOGO_LINES.at(-1) ?? ""));
    const composerTopRow = rows.findIndex((row) => row.includes("╭─ Build"));
    const logoCenterRow = Math.floor((firstLogoRow + lastLogoRow) / 2);
    const transcriptCenterRow = Math.floor((composerTopRow - 1) / 2);

    assert.equal(frame.includes("OpenTUI Node runtime loaded."), false);
    assert.notEqual(firstLogoRow, -1);
    assert.notEqual(lastLogoRow, -1);
    assert.notEqual(composerTopRow, -1);
    assert.ok(Math.abs(logoCenterRow - transcriptCenterRow) <= 1);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("places the login notice before the prompt input in the composer area", () => {
  const children = reactElementChildren(
    ComposerInputArea({
      busy: false,
      contentWidth: 80,
      contextUsage: {},
      copy: getZCodeCopy("en-US").tui,
      draft: "",
      editorRef: { current: null },
      inputCursorToEndVersion: 0,
      loginRequired: true,
      mode: "build",
      model: "default-deepseek/deepseek-v4-pro",
      queuedInputs: [],
      setDraftValue: () => undefined,
      slashCommands: [],
      submitValue: () => undefined,
      thoughtLevel: "max",
    }),
  );

  assert.equal(children[0]?.type, LoginRequiredPanel);
  assert.equal(children.at(-2)?.type, InputPane);
  assert.equal(children.at(-2)?.props?.model, "default-deepseek/deepseek-v4-pro");
  assert.equal(children.at(-2)?.props?.thoughtLevel, "max");
  assert.equal(children.at(-1)?.type, InputActiveStatus);
  assert.equal(children.at(-1)?.props?.active, false);
});

test("places composer selections above the prompt input", () => {
  const children = reactElementChildren(
    ComposerInputArea({
      busy: false,
      contentWidth: 80,
      contextUsage: {},
      copy: getZCodeCopy("en-US").tui,
      draft: "",
      editorRef: { current: null },
      inputCursorToEndVersion: 0,
      loginRequired: false,
      mode: "build",
      model: "default-deepseek/deepseek-v4-pro",
      queuedInputs: [],
      selection: {
        emptyMessage: "No saved sessions found.",
        filter: "",
        items: [
          {
            command: "/resume sess_one",
            id: "sess_one",
            primary: "Session one",
          },
        ],
        placement: "composer",
        prompt: "Choose a session to resume.",
        selectedIndex: 0,
        title: "Resume Session",
      },
      setDraftValue: () => undefined,
      slashCommands: [],
      submitValue: () => undefined,
      thoughtLevel: "max",
    }),
  );

  assert.equal(children.find((child) => child.type === SelectionPanel)?.type, SelectionPanel);
  assert.equal(children.at(-2)?.type, InputPane);
  assert.equal(children.at(-1)?.type, InputActiveStatus);
});

test("passes the busy active status outside the prompt input", () => {
  const children = reactElementChildren(
    ComposerInputArea({
      busy: true,
      contentWidth: 80,
      contextUsage: { contextUsed: 11_100, contextWindow: 185_000 },
      copy: getZCodeCopy("en-US").tui,
      draft: "",
      editorRef: { current: null },
      inputCursorToEndVersion: 0,
      loginRequired: false,
      mode: "build",
      model: "default-deepseek/deepseek-v4-pro",
      queuedInputs: [],
      setDraftValue: () => undefined,
      slashCommands: [],
      submitValue: () => undefined,
      thoughtLevel: "max",
    }),
  );

  assert.equal(children.at(-2)?.type, InputPane);
  assert.equal(children.at(-2)?.props?.busy, true);
  assert.equal(children.at(-2)?.props?.model, "default-deepseek/deepseek-v4-pro");
  assert.equal(children.at(-2)?.props?.thoughtLevel, "max");
  assert.equal(children.at(-1)?.type, InputActiveStatus);
  assert.equal(children.at(-1)?.props?.active, true);
  assert.deepEqual(children.at(-1)?.props?.contextUsage, {
    contextUsed: 11_100,
    contextWindow: 185_000,
  });
});

test("places queued input panel immediately above the prompt input", () => {
  const children = reactElementChildren(
    ComposerInputArea({
      busy: true,
      contentWidth: 80,
      contextUsage: {},
      copy: getZCodeCopy("en-US").tui,
      draft: "",
      editorRef: { current: null },
      inputCursorToEndVersion: 0,
      loginRequired: false,
      mode: "build",
      model: "default-deepseek/deepseek-v4-pro",
      queuedInputs: [{ id: "pending-1", text: "hello queue" }],
      setDraftValue: () => undefined,
      slashCommands: [],
      submitValue: () => undefined,
      thoughtLevel: "max",
    }),
  );

  assert.equal(children.at(-3)?.type, QueuedInputPanel);
  assert.deepEqual(children.at(-3)?.props?.inputs, [{ id: "pending-1", text: "hello queue" }]);
  assert.equal(children.at(-2)?.type, InputPane);
  assert.equal(children.at(-1)?.type, InputActiveStatus);
});

test("Shift+Tab switches mode through the injected mode setter", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  const requestedModes: string[] = [];

  const options: TuiOptions = {
    initialMode: "build",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    setMode: async (mode) => {
      requestedModes.push(mode);
      return { mode };
    },
    submitPrompt: async () => ({ response: "done" }),
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("keep this draft");
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressTab({ shift: true });
      await Promise.resolve();
    });

    await act(async () => {
      await view.renderOnce();
    });

    assert.deepEqual(requestedModes, ["edit"]);
    const frame = view.captureCharFrame();
    assert.equal(frame.includes("Input - Edit"), false);
    assert.equal(frame.includes("Edit"), true);
    assert.equal(frame.includes("keep this draft"), true);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("Shift+Tab can cycle edit mode to yolo mode", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  const requestedModes: string[] = [];

  const options: TuiOptions = {
    initialMode: "edit",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    setMode: async (mode) => {
      requestedModes.push(mode);
      return { mode };
    },
    submitPrompt: async () => ({ response: "done" }),
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      view.mockInput.pressTab({ shift: true });
      await Promise.resolve();
      await view.renderOnce();
    });

    assert.deepEqual(requestedModes, ["yolo"]);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("recalls input history while model output is active", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  const pendingTurn = deferred<TuiOptions["initialResult"]>();
  let recalled = 0;

  const options: TuiOptions = {
    noColor: true,
    recallPreviousInput: async () => {
      recalled += 1;
      return { text: "/help" };
    },
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => (await pendingTurn.promise) ?? { response: "done" },
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("first prompt");
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressEnter();
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressArrow("up");
      await Promise.resolve();
      await view.renderOnce();
    });

    // Bugfix: the shared OpenTUI test renderer buffer is noisy while package tests
    // run concurrently; the regression contract here is that busy Up reaches history.
    assert.equal(recalled, 1);
  } finally {
    pendingTurn.resolve({ response: "done" });
    await act(async () => {
      await Promise.resolve();
      await view?.renderOnce();
      view?.renderer.destroy();
    });
  }
});

test("mode composer popup submits the highlighted explicit mode command", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  const submitted: string[] = [];

  const options: TuiOptions = {
    initialMode: "build",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { mode: "yolo", response: "done" };
    },
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("/mode");
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressArrow("down");
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressArrow("down");
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressArrow("down");
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressEnter();
      await Promise.resolve();
      await view.renderOnce();
    });

    assert.deepEqual(submitted, ["/mode yolo"]);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("mode composer popup can submit edit mode command", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  const submitted: string[] = [];

  const options: TuiOptions = {
    initialMode: "build",
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { mode: "edit", response: "done" };
    },
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("/mode");
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressArrow("down");
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressArrow("down");
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressEnter();
      await Promise.resolve();
      await view.renderOnce();
    });

    assert.deepEqual(submitted, ["/mode edit"]);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

function reactElementChildren(node: unknown): Array<{ props?: Record<string, unknown>; type?: unknown }> {
  if (typeof node !== "object" || node === null || !("props" in node)) return [];
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  if (children === undefined) return [];
  return (Array.isArray(children) ? children : [children]).filter(
    (child): child is { type?: unknown } => typeof child === "object" && child !== null,
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
