import { afterEach, expect, it, vi } from "vitest";
import { sandboxPages, type SandboxPageOwner } from "./sandboxPageOwners.js";
import { acquirePluginUiPage } from "@/plugin-ui/adapters/pluginUiPageRegistry.js";

it("starts an admitted MCP owner once without any React subscriber or anchor", async () => {
  const start = vi.fn();
  const create = vi.fn(
    () =>
      ({
        kind: "mcp",
        key: "background",
        task: "requested",
        visible: false,
        start,
        busy: () => false,
        running: () => false,
        suspend: () => false,
        destroy: vi.fn(),
      }) as never,
  );
  const first = acquirePluginUiPage("background", create);
  const second = acquirePluginUiPage("background", create);
  expect(await first).toBe(await second);
  expect(create).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});

afterEach(() => {
  sandboxPages.clear();
  vi.useRealTimers();
});
it("counts MCP and Gen UI against one capacity and deletes both for the same task", async () => {
  const pages: SandboxPageOwner[] = [];
  for (let index = 0; index < 64; index++) {
    const page: SandboxPageOwner = {
      kind: index % 2 ? "mcp" : "gen-ui",
      key: String(index),
      task: "shared-task",
      visible: true,
      busy: () => false,
      running: () => true,
      suspend: vi.fn(),
      destroy: vi.fn(),
    };
    pages.push(page);
    await sandboxPages.add(page);
    await sandboxPages.reserve(page);
  }
  const extra = { ...pages[0]!, key: "overflow" };
  await sandboxPages.add(extra);
  await expect(sandboxPages.reserve(extra)).rejects.toThrow("capacity");
  sandboxPages.removeTask("shared-task");
  for (const page of pages) {
    expect(page.destroy).toHaveBeenCalled();
    expect(sandboxPages.get(page.key)).toBeUndefined();
    sandboxPages.released(page);
  }
});
