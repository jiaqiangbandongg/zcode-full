import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { toDraftAttachments, toPromptInput } from "../src/app-input.js";
import { TuiApp } from "../src/app.js";
import type { TuiOptions, TuiPromptInput } from "../src/types.js";

test("submits pasted clipboard images as prompt attachments", async () => {
  let submitted: TuiPromptInput | undefined;
  let clipboardReads = 0;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    readClipboardImage: async () => {
      clipboardReads += 1;
      return {
        dataUrl: "data:image/png;base64,aW1hZ2U=",
        mediaType: "image/png",
        sizeBytes: 5,
      };
    },
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
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await Promise.resolve();
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.pressKeys(["\x16"]);
      await Promise.resolve();
      await view.mockInput.typeText("图片里文字是啥");
      view.mockInput.pressEnter();
      await view.renderOnce();
    });

    assert.equal(clipboardReads, 1);
    assert.deepEqual(submitted, {
      attachments: [
        {
          content: "data:image/png;base64,aW1hZ2U=",
          path: "[image #1]",
          type: "image",
        },
      ],
      text: "[image #1]图片里文字是啥",
    });
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("maps recalled image prompt attachments back to draft attachments", () => {
  const draftAttachments = toDraftAttachments(
    [
      {
        content: "data:image/png;base64,aW1hZ2U=",
        path: "[image #3]",
        type: "image",
      },
    ],
    () => {
      throw new Error("placeholder id should be restored from history");
    },
  );

  assert.deepEqual(toPromptInput("[image #3]图片里文字是啥", draftAttachments), {
    attachments: [
      {
        content: "data:image/png;base64,aW1hZ2U=",
        path: "[image #3]",
        type: "image",
      },
    ],
    text: "[image #3]图片里文字是啥",
  });
});
