import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { runTuiWithRenderer } from "../../tui/src/tui.js";
import { TUI_SWITCHABLE_MODES } from "../../tui/src/app-mode.js";
import type { TuiOptions } from "../../tui/src/types.js";
import { resolveExecutionState } from "@zcode/shared";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import { createCliModeState, currentCliMode } from "../src/tui-command-state.js";
import type { RunDependencies } from "../src/cli-types.js";

async function fixture(overrides: Partial<TuiOptions> = {}) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    width: 110,
    height: 32,
    targetFps: 30,
    screenMode: "alternate-screen",
    useThread: false,
  });
  terminal.renderer.waitForThemeMode = async () => "dark";
  const modes: string[] = [];
  let outcome!: Promise<number>;
  await React.act(async () => {
    outcome = runTuiWithRenderer(
      {
        noColor: true,
        locale: "en-US",
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        initialMode: "yolo",
        workspaceDirectory: "/test/workspace",
        submitPrompt: async () => ({ response: "" }),
        setMode: async (mode) => {
          modes.push(mode);
          return { mode };
        },
        ...overrides,
      },
      terminal.renderer,
    );
  });
  return {
    ...terminal,
    modes,
    async action(work: () => void | Promise<void>) {
      await React.act(async () => {
        await work();
      });
      await React.act(async () => {
        await terminal.renderOnce();
      });
    },
    async close() {
      await React.act(async () => terminal.renderer.destroy());
      await outcome;
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    },
  };
}

test("terminal Shift+Tab cycles modes with an empty or populated composer", async () => {
  const terminal = await fixture();
  try {
    await terminal.action(() => terminal.renderOnce());
    // 循环顺序以 TUI_SWITCHABLE_MODES 为准：staging 新增 guarded 并把 edit 移出 Shift+Tab 循环。
    for (const mode of TUI_SWITCHABLE_MODES) {
      await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
      assert.equal(terminal.modes.at(-1), mode);
      assert.match(
        terminal.captureCharFrame(),
        new RegExp(` ${mode[0].toUpperCase()}${mode.slice(1)} `),
      );
    }
    await terminal.action(() => terminal.mockInput.typeText("keep this draft"));
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(terminal.modes, [...TUI_SWITCHABLE_MODES, "plan"]);
    assert.match(terminal.captureCharFrame(), /keep this draft/);
  } finally {
    await terminal.close();
  }
});

test("Shift+Tab still reaches the app after the startup screen is replaced", async () => {
  const terminal = await fixture({
    loadStartupOptions: async () => ({ initialMode: "yolo" }),
  });
  try {
    await terminal.action(() => terminal.renderOnce());
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(terminal.modes, ["plan"]);
  } finally {
    await terminal.close();
  }
});

test("Shift+Tab switches mode while file suggestions are open; Tab still completes the file", async () => {
  const terminal = await fixture({
    listWorkspacePathSuggestions: async () => ({
      items: [{ path: "README.md", kind: "file" }],
      truncated: false,
    }),
  });
  try {
    await terminal.action(() => terminal.mockInput.typeText("@READ"));
    assert.match(terminal.captureCharFrame(), /README.md/);
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(terminal.modes, ["plan"]);
    assert.match(terminal.captureCharFrame(), /@READ\s/);
    assert.doesNotMatch(terminal.captureCharFrame(), /@README.md/);
    await terminal.action(() => terminal.mockInput.pressTab());
    assert.match(terminal.captureCharFrame(), /@README.md/);
    assert.deepEqual(terminal.modes, ["plan"]);
  } finally {
    await terminal.close();
  }
});

test("runtime Plan state survives Shift+Tab responses and metadata refreshes", async () => {
  let execution = resolveExecutionState({ mode: "yolo" });
  const state = createCliModeState();
  const app = {
    getMode: () => execution.mode,
    runtime: { getPlanEnabled: () => execution.planEnabled },
    setMode: async (mode: string) => {
      execution = resolveExecutionState({ mode }, execution);
      // The real facade returns the permission mode, independently of Plan.
      return { mode: execution.mode };
    },
    listModels: () => [],
    close: async () => {},
  };
  const handler = createTuiSubmitPrompt(
    {
      env: {},
      cwd: () => process.cwd(),
      skipUserConfig: true,
      loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
      createZCodeApp: async () => app,
      startProcessProviderRegistryRuntime: async () => ({
        runtime: { registryService: {} },
        dispose() {},
      }),
    } as unknown as RunDependencies,
    state,
    "test",
  );
  await handler.getSessionMetadata!();
  const terminal = await fixture({ initialMode: currentCliMode(state), setMode: handler.setMode });
  try {
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(execution, { mode: "yolo", planEnabled: true });
    assert.match(terminal.captureCharFrame(), / Plan /);
    await handler.getSessionMetadata!();
    assert.equal(currentCliMode(state), "plan");
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(execution, { mode: "build", planEnabled: false });
    assert.match(terminal.captureCharFrame(), / Build /);
  } finally {
    await terminal.close();
    await handler.close!();
  }
});
