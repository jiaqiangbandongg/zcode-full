import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPluginSandboxProtocolHandler } from "./protocol.js";
import { createPluginSandboxRegistry } from "./registry.js";

const fragment = `<html><head><!--__ZCODE_GEN_UI_STYLES__--><script src="__ZCODE_GEN_UI_RUNTIME__"></script></head><body><script>author()</script><!--__ZCODE_GEN_UI_INNER_KIT__--></body></html>`;
function fixture(kind: "gen-ui" | "mcp-app", html = fragment, missing = false) {
  const registry = createPluginSandboxRegistry();
  const instance = { runtimeId: "a", generation: 1, token: "one", appIdentity: "a".repeat(64) };
  const handle = registry.register({
    instance,
    contentKind: kind,
    ownerWebContentsId: 1,
    workspacePath: "/repo",
    sessionId: "s",
    scopeId: "view",
    html,
    ...(kind === "mcp-app" ? { pluginId: "p", serverName: "m" } : {}),
  });
  const resources: Record<string, string> = {
    "visualize.css": "/* preset styles */",
    "visualize.html": "<!--__INLINE_VISUALIZATION_FRAGMENT__--><script>innerKit()</script>",
    "calendar.js": "calendar()",
    "manifest.json": JSON.stringify({
      resources: [
        { url: "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js", file: "d3-7.9.0.min.js" },
      ],
    }),
    "d3-7.9.0.min.js": "/* bundled D3 */",
  };
  const readAsset = vi.fn(async (path: string) => {
    if (missing || !resources[basename(path)]) throw new Error("Missing resource");
    return new TextEncoder().encode(resources[basename(path)]);
  });
  const handler = createPluginSandboxProtocolHandler({
    registry,
    assets: { rendererDir: "/renderer", aliasDir: "/runtime" },
    readAsset,
  });
  return {
    readAsset,
    dispose: () => registry.dispose(handle.sandboxId, handle.initId),
    request: (path = "", identity = instance.appIdentity) =>
      handler(
        new Request(`zcode-sandbox://plugin-${identity}/instance/${handle.sandboxId}/${path}`),
      ),
  };
}

describe("Gen UI resource composition", () => {
  it("serves only registered vendor scripts under the authorized Gen UI instance", async () => {
    const genUi = fixture("gen-ui");
    const path = "__zcode__/vendor/d3-7.9.0.min.js";
    const response = await genUi.request(path);
    expect(await response.text()).toBe("/* bundled D3 */");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect((await genUi.request("__zcode__/vendor/unknown.js")).status).toBe(404);
    expect((await genUi.request("__zcode__/vendor/manifest.json")).status).toBe(404);
    expect((await genUi.request(path, "b".repeat(64))).status).toBe(404);
    expect((await fixture("mcp-app").request(path)).status).toBe(404);
    genUi.dispose();
    expect((await genUi.request(path)).status).toBe(404);
  });
  it("does not fall back to the CDN when a declared vendor file is absent", async () => {
    const genUi = fixture("gen-ui");
    await genUi.request("__zcode__/vendor/unknown.js");
    genUi.readAsset.mockRejectedValue(new Error("missing vendor file"));
    expect((await genUi.request("__zcode__/vendor/d3-7.9.0.min.js")).status).toBe(404);
  });
  it("loads the canonical CSS and places the bridge before authors and inner kit after them", async () => {
    const { request, readAsset } = fixture("gen-ui");
    const response = await request();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.indexOf("preset styles")).toBeLessThan(html.indexOf("/__zcode__/gen-ui.js"));
    expect(html.indexOf("/__zcode__/gen-ui.js")).toBeLessThan(html.indexOf("author()"));
    expect(html.indexOf("author()")).toBeLessThan(html.indexOf("innerKit()"));
    expect(html.indexOf("author()")).toBeLessThan(
      html.indexOf('id="zcode-gen-ui-document-scrollbar"'),
    );
    expect(html).toContain("html,body{scrollbar-width:none!important}");
    expect(html).toContain(
      "html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}",
    );
    expect(html).not.toContain("overflow-y:hidden!important");
    expect(html).not.toContain("__INLINE_VISUALIZATION_FRAGMENT__");
    expect(readAsset.mock.calls.map(([path]) => basename(path)).sort()).toEqual([
      "visualize.css",
      "visualize.html",
    ]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("registers calendar synchronously before authors only when the fragment references it", async () => {
    const { request, readAsset } = fixture(
      "gen-ui",
      fragment.replace("author()", "author('VIZ-CALENDAR')"),
    );
    const html = await (await request()).text();
    expect(html.indexOf("calendar()")).toBeLessThan(html.indexOf("author("));
    expect(readAsset.mock.calls.map(([path]) => basename(path))).toContain("calendar.js");
  });
  it("does not inject Gen UI resources into an MCP App", async () => {
    const { request, readAsset } = fixture("mcp-app");
    const html = await (await request()).text();
    expect(html).toContain("/__zcode__/alias.js");
    expect(html).not.toContain("innerKit()");
    expect(html).not.toContain("zcode-gen-ui-document-scrollbar");
    expect(readAsset).not.toHaveBeenCalled();
  });
  it("returns an explicit failure when the packaged runtime is missing", async () => {
    const { request } = fixture("gen-ui", fragment, true);
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
