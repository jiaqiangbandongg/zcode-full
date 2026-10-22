import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "./e2e/helpers/upstream-replay-server.js";

const fixturePath = fileURLToPath(
  new URL(
    "./e2e/fixtures/upstream/conversation-session/conversation-session-r3-mobile.json",
    import.meta.url,
  ),
);
const servers: UpstreamReplayServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function start() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-mobile-fixture-"));
  directories.push(directory);
  const server = await startUpstreamReplayServer({
    artifactPath: join(directory, "requests.json"),
    fixturePaths: [fixturePath],
  });
  servers.push(server);
  return server;
}

describe("手机恢复与跨端队列的真实 fixture", () => {
  it.each([
    {
      fixtureId: "r3-mob-slow",
      prompt: "E2E_R3_MOBILE_SLOW",
      running: "R3_MOBILE_STREAMING",
      done: "R3_MOBILE_STREAM_DONE",
    },
    {
      fixtureId: "r3-mob-from-mobile",
      prompt: "E2E_R3_MOBILE_FROM_MOBILE",
      running: "R3_MOBILE_FROM_MOBILE_RUNNING",
      done: "R3_MOBILE_FROM_MOBILE_REPLY",
    },
  ])(
    "$fixtureId 在显式释放前不结束，完成标记只在释放后出现",
    async ({ fixtureId, prompt, running, done }) => {
      const server = await start();
      const response = await fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes(running)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).not.toContain(done);
      expect(await fetch(`${server.baseUrl}/__e2e__/gates`).then((value) => value.json())).toEqual([
        fixtureId,
      ]);
      expect(
        (await fetch(`${server.baseUrl}/__e2e__/release/${fixtureId}`, { method: "POST" })).status,
      ).toBe(204);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text.match(new RegExp(done, "gu"))).toHaveLength(1);
      expect(text).toContain("event: message_stop");
    },
  );

  it("桌面输入携带手机历史时仍命中桌面回复，不误命中旧手机回合", async () => {
    const server = await start();
    const response = await fetch(`${server.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "E2E_R3_MOBILE_FROM_MOBILE" },
          { role: "assistant", content: "R3_MOBILE_FROM_MOBILE_REPLY" },
          { role: "user", content: "E2E_R3_MOBILE_FROM_DESKTOP" },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    expect(text).toContain("R3_MOBILE_FROM_DESKTOP_REPLY");
    expect(text).not.toContain("R3_MOBILE_FROM_MOBILE_REPLY");
  });
});
