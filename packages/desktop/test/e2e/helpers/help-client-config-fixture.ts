import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

export const HELP_FIXTURE_PATH = resolve(
  import.meta.dirname,
  "../fixtures/fs/settings/help-client-config/config.json",
);
export interface HelpFixtureConfig {
  community_urls?: Partial<Record<"zh-CN" | "en-US", string>>;
  feedback_url?: string;
  feedback_use_external_form?: boolean;
}
export async function readHelpFixture(): Promise<{
  remote: HelpFixtureConfig;
  local: HelpFixtureConfig;
}> {
  return JSON.parse(await readFile(HELP_FIXTURE_PATH, "utf8"));
}

export async function startHelpConfigFixture(config: HelpFixtureConfig, browserBundle?: string) {
  let payload: unknown = { code: 0, data: { configs: { feedbackUrl: config } } };
  let status = 200;
  let raw: string | undefined;
  let responseGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> =
    [];
  const server = createServer((req, res) => {
    if (req.url === "/web-helper.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end(browserBundle ?? "");
      return;
    }
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width"><title>E2E_HELP_WEB</title><script src="/web-helper.js"></script>',
      );
      return;
    }
    if (!req.url?.startsWith("/api/v1/client/configs?")) {
      res.writeHead(404);
      res.end();
      return;
    }
    requests.push({ url: req.url, headers: req.headers });
    // 服务端刻意允许缓存；客户端 no-store 应保证新页面仍拿到新响应。
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
    const body = raw ?? JSON.stringify(payload);
    if (responseGate) void responseGate.promise.then(() => res.end(body));
    else res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    holdResponses() {
      if (responseGate) throw new Error("Help config responses are already held");
      const gate = Promise.withResolvers<void>();
      responseGate = gate;
      return () => {
        responseGate = undefined;
        gate.resolve();
      };
    },
    setClientConfigs(configs: Record<string, unknown>) {
      payload = { code: 0, data: { configs } };
      status = 200;
      raw = undefined;
    },
    setConfig(value: HelpFixtureConfig) {
      payload = { code: 0, data: { configs: { feedbackUrl: value } } };
      status = 200;
      raw = undefined;
    },
    setFailure(kind: "http" | "business" | "json") {
      status = kind === "http" ? 503 : 200;
      payload = { code: 1, data: { configs: { feedbackUrl: config } } };
      raw = kind === "json" ? "invalid json" : undefined;
    },
    async close() {
      responseGate?.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

export async function buildHelpBrowserFixture(): Promise<string> {
  const result = await build({
    stdin: {
      contents:
        'import * as help from "./packages/web/src/communityUrl.ts"; window.helpFixture = help;',
      resolveDir: resolve(import.meta.dirname, "../../../../.."),
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "import.meta.env": "{}" },
  });
  return result.outputFiles[0]!.text;
}
