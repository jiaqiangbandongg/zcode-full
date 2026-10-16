// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPluginStoreOpenListener,
  consumePluginStoreOpenTarget,
  requestPluginStoreOpen,
} from "@/lib/pluginStoreNavigation.js";

describe("plugin store navigation target", () => {
  beforeEach(() => {
    consumePluginStoreOpenTarget();
  });

  it("dispatches and preserves a one-shot target Plugin ID for the store page", () => {
    const listener = vi.fn();
    const dispose = addPluginStoreOpenListener(listener);

    requestPluginStoreOpen("document-skills@zcode-plugins-official");

    expect(listener).toHaveBeenCalledWith({
      pluginId: "document-skills@zcode-plugins-official",
    });
    expect(consumePluginStoreOpenTarget()).toEqual({
      pluginId: "document-skills@zcode-plugins-official",
    });
    expect(consumePluginStoreOpenTarget()).toBeNull();
    dispose();
  });

  it("normalizes an empty target to an ordinary store navigation", () => {
    requestPluginStoreOpen("  ");

    expect(consumePluginStoreOpenTarget()).toEqual({});
  });

  it("normalizes legacy Workspace return keys to the global User view", () => {
    const listener = vi.fn();
    const dispose = addPluginStoreOpenListener(listener);
    const first = "remote:ssh:host-a:22:user:/workspace";
    const second = "remote:ssh:host-b:22:user:/workspace";

    requestPluginStoreOpen(first);
    requestPluginStoreOpen(second);

    expect(listener.mock.calls.map(([target]) => target)).toEqual([
      { returnScopeKey: "user" },
      { returnScopeKey: "user" },
    ]);
    expect(consumePluginStoreOpenTarget()).toEqual({ returnScopeKey: "user" });
    dispose();
  });
});

it("carries a one-shot add-marketplace intent without changing legacy navigation", () => {
  requestPluginStoreOpen({ intent: "add-marketplace" });
  expect(consumePluginStoreOpenTarget()).toEqual({ intent: "add-marketplace" });
  expect(consumePluginStoreOpenTarget()).toBeNull();
});
