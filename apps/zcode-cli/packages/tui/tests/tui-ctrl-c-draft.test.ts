import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { TuiApp } from "../src/app.js";
import type { TuiOptions, TuiPromptInput } from "../src/types.js";

test("Ctrl-C clears a non-empty prompt draft without exiting or submitting", async () => {
  let exitCount = 0;
  const submitted: TuiPromptInput[] = [];
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(input);
      return { response: "done" };
    },
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => {
          exitCount += 1;
        },
        options,
      }),
      {
        exitOnCtrlC: false,
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
      await view.mockInput.typeText("draft to clear");
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressCtrlC();
      await Promise.resolve();
      await view.renderOnce();
    });

    assert.equal(exitCount, 0);

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressEnter();
      await Promise.resolve();
      await view.renderOnce();
    });

    assert.deepEqual(submitted, []);

    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("fresh prompt");
      view.mockInput.pressEnter();
      await Promise.resolve();
      await view.renderOnce();
    });

    assert.deepEqual(submitted, ["fresh prompt"]);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("Ctrl-C clears pasted image draft attachments", async () => {
  let submitted: TuiPromptInput | undefined;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    readClipboardImage: async () => ({
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      mediaType: "image/png",
      sizeBytes: 5,
    }),
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted = input;
      return { response: "done" };
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
        exitOnCtrlC: false,
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
      await view.mockInput.pressKeys(["\x16"]);
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressCtrlC();
      await Promise.resolve();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("[image #1] reused as plain text");
      view.mockInput.pressEnter();
      await Promise.resolve();
      await view.renderOnce();
    });

    assert.equal(submitted, "[image #1] reused as plain text");
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});
