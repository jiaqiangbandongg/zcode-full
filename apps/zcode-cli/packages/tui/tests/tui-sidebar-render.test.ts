import assert from "node:assert/strict";
import test from "node:test";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import React, { act } from "react";
import type { SidebarState } from "../src/app-model.js";
import { Sidebar } from "../src/app-sidebar.js";

test("renders localized sidebar rows without section title glyph tails", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  await act(async () => {
    view = await testRender(
      React.createElement(
        "box",
        { style: { height: 44, width: 42 } },
        React.createElement(Sidebar, {
          ...baseSidebarState,
          copy: getZCodeCopy("zh-CN").tui,
          developerMode: true,
          status: "就绪。",
        }),
      ),
      {
        height: 44,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 42,
      },
    );
    await view.flush();
  });

  try {
    assert.ok(view);
    const lines = view
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd());

    // Todos 改为可折叠区块，标题与 API 等区块一样带展开标记。
    assert.ok(lines.includes(" ▼ Todos"));
    assert.ok(lines.includes(" 进度      0/0"));
    assert.ok(lines.includes(" ▼ API"));
    assert.ok(lines.includes(" 模型      -"));
    assert.equal(
      lines.some((line) => line.includes("进度s")),
      false,
    );
    assert.equal(
      lines.some((line) => line.includes("模型I")),
      false,
    );
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

const baseSidebarState: SidebarState = {
  busy: false,
  contextUsage: {},
  draft: "",
  lastEvent: "idle",
  messageCount: 0,
  mcpStatus: {
    loading: false,
    servers: {},
  },
  mode: "build",
  model: "glm-4.6",
  modifiedFiles: [],
  networkRequests: [],
  status: "Ready.",
  statusDetails: [],
  thoughtLevel: "medium",
  todos: [],
};
