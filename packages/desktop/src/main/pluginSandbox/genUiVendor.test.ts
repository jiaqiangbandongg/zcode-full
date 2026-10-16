import { describe, expect, it, vi } from "vitest";
import { createGenUiVendorResources, resolveGenUiVendorRedirect } from "./genUiVendor.js";
import { createPluginSandboxRegistry } from "./registry.js";

const url = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const manifest = { resources: [{ url, file: "d3-7.9.0.min.js" }] };
const registry = createPluginSandboxRegistry();
const input = {
  instance: { runtimeId: "a", generation: 1, token: "one", appIdentity: "a".repeat(64) },
  ownerWebContentsId: 1,
  workspacePath: "/repo",
  sessionId: "s",
  scopeId: "view",
  html: "",
};
const genUi = registry.register({ ...input, contentKind: "gen-ui" });
const mcp = registry.register({ ...input, pluginId: "p", serverName: "s" });

describe("bundled Gen UI scripts", () => {
  it("maps only the exact pinned URL for an active Gen UI and reads the manifest once", async () => {
    const readAsset = vi.fn(async () => new TextEncoder().encode(JSON.stringify(manifest)));
    const resources = createGenUiVendorResources("/assets", readAsset);
    expect(await resolveGenUiVendorRedirect(url, registry.get(genUi.sandboxId), resources)).toBe(
      `zcode-sandbox://plugin-${input.instance.appIdentity}/instance/${genUi.sandboxId}/__zcode__/vendor/d3-7.9.0.min.js`,
    );
    for (const candidate of [
      url + "?v=1",
      url + ".map",
      url.replace("7.9.0", "7.8.0"),
      url.replace("https:", "http:"),
    ]) {
      expect(
        await resolveGenUiVendorRedirect(candidate, registry.get(genUi.sandboxId), resources),
      ).toBeUndefined();
    }
    expect(await resources.hasFile("d3-7.9.0.min.js")).toBe(true);
    expect(await resources.hasFile("../d3-7.9.0.min.js")).toBe(false);
    expect(readAsset).toHaveBeenCalledTimes(1);
    expect(
      await resolveGenUiVendorRedirect(url, registry.get(mcp.sandboxId), resources),
    ).toBeUndefined();
    expect(await resolveGenUiVendorRedirect(url, null, resources)).toBeUndefined();
  });
  it("rejects missing, malformed and ambiguous manifests instead of requesting a CDN fallback", async () => {
    const missing = createGenUiVendorResources("/assets", async () => {
      throw new Error("missing");
    });
    await expect(missing.fileForUrl(url)).rejects.toThrow("missing");
    for (const resources of [
      [{ url, file: "../escape.js" }],
      [...manifest.resources, ...manifest.resources],
    ]) {
      const invalid = createGenUiVendorResources("/assets", async () =>
        new TextEncoder().encode(JSON.stringify({ resources })),
      );
      await expect(invalid.fileForUrl(url)).rejects.toThrow();
    }
  });
});
