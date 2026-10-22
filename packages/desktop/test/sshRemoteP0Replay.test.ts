import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { startUpstreamReplayServer } from "#e2e/helpers/upstream-replay-server";

it.each(["a-first", "b-first", "a-follow", "b-follow"])(
  "SSH P0 %s 先输出正文，显式释放后才结束回合",
  async (turn) => {
    const dir = await mkdtemp(join(tmpdir(), "ssh-p0-replay-"));
    const server = await startUpstreamReplayServer({
      artifactPath: join(dir, "capture.json"),
      fixturePaths: [
        fileURLToPath(
          new URL(
            "./e2e/fixtures/upstream/conversation-session/conversation-session-ssh-remote-p0.json",
            import.meta.url,
          ),
        ),
      ],
    });
    try {
      const [label, phase] = turn.toUpperCase().split("-");
      const messages = [
        ...(phase === "FOLLOW"
          ? [{ role: "user", content: `E2E_SSH_REMOTE_P0_${label}_FIRST_PROMPT` }]
          : []),
        { role: "user", content: `E2E_SSH_REMOTE_P0_${label}_${phase}_PROMPT` },
      ];
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain(`E2E_SSH_REMOTE_P0_${label}_${phase}_REPLY`);
      expect(first).not.toContain("[DONE]");
      const fixtureId = `ssh-remote-p0-${turn}`;
      expect(await fetch(`${server.baseUrl}/__e2e__/gates`).then((value) => value.json())).toEqual([
        fixtureId,
      ]);
      expect(
        (await fetch(`${server.baseUrl}/__e2e__/release/${fixtureId}`, { method: "POST" })).status,
      ).toBe(204);
      let rest = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      expect(rest).toContain("[DONE]");
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
