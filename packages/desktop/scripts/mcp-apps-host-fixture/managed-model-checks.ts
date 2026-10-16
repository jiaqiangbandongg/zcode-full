import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
export async function checkModel(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  const page = (code: string) => env.evalPage(win, code);
  const command = (type: string, payload: unknown) =>
    env.agent.call("v4/command", {
      commandId: randomUUID(),
      clientId: "fixture-client",
      sessionId: scope.sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    });
  const permission = (key: string) => env.agent.approvals.wait((r) => r.params.input?.key === key);
  const terminal = (after: number) =>
    env.agent.notifications.wait(
      (e) =>
        e.method === "v4/telemetry/event" &&
        e.params.kind === "turn.terminal" &&
        e.params.sessionId === scope.sessionId,
      after,
    );
  async function begin(key: string) {
    const after = env.agent.notifications.history.length;
    env.model.plans.push({ key, delayed: true });
    const ack = await command("sendText", {
      text: `fixture ${key}`,
      modelSelection: env.model.selection,
      mode: "build",
    });
    assert.equal(ack.status, "accepted");
    const request = await env.model.requests.wait((r) => r.plan?.key === key);
    assert.ok(request.tool);
    return after;
  }
  await check(
    "model discovers page tool, duplicate live frames execute once across anchor switch",
    async () => {
      const offset = env.events.history.length;
      const after = await begin("model-page");
      await env.agent.respond(await permission("model-page"), "allow");
      await env.events.wait((e) => e.type === "claimAppToolCall" && e.result.accepted, offset);
      await page("window.waitPageCall('model-page')");
      const delivered = env.agent.notifications.history.find((e) =>
        e.params?.frame?.payload?.deltas?.some(
          (d: any) =>
            d.op === "pluginUi.appToolCall" && d.arguments?.key === "model-page" && !d.activity,
        ),
      );
      assert.ok(delivered);
      for (let n = 0; n < 5; n++)
        win.webContents.send("fixture-notification", { kind: "frame", value: delivered.params });
      assert.equal((await ui("window.managedState()")).busy, true);
      await ui("window.setAnchors(false, true)");
      await page("window.releasePageCall('model-page')");
      const result = await env.events.wait((e) => e.type === "resolveAppToolCall", offset);
      assert.equal(result.params.result.structuredContent.key, "model-page");
      assert.equal(result.result.accepted, true);
      assert.deepEqual(await page("window.pageCalls"), [{ key: "model-page", aborted: false }]);
      assert.equal(
        env.events.history.slice(offset).filter((e) => e.type === "claimAppToolCall").length,
        1,
      );
      assert.equal((await terminal(after)).params.status, "success");
    },
  );
  await check(
    "model cancellation while approval pending rejects late allow without executing page",
    async () => {
      const after = await begin("model-approval-cancel");
      const pending = await permission("model-approval-cancel");
      await command("stop", {});
      await env.agent.respond(pending, "allow");
      await terminal(after);
      assert.equal(
        await page("window.pageCalls.filter(c => c.key === 'model-approval-cancel').length"),
        0,
      );
    },
  );
  await check(
    "model cancellation before claim denies stale claim and never invokes SDK handler",
    async () => {
      const gate = Promise.withResolvers<void>();
      env.gates.set("claimAppToolCall", gate.promise);
      const offset = env.events.history.length;
      const after = await begin("model-claim-cancel");
      await env.agent.respond(await permission("model-claim-cancel"), "allow");
      await env.events.wait(
        (e) => e.type === "app-tools-arrived" && e.method === "claimAppToolCall",
        offset,
      );
      await command("stop", {});
      env.gates.delete("claimAppToolCall");
      gate.resolve();
      const claim = await env.events.wait((e) => e.type === "claimAppToolCall", offset);
      assert.equal(claim.result.accepted, false);
      await terminal(after);
      assert.equal(
        await page("window.pageCalls.filter(c => c.key === 'model-claim-cancel').length"),
        0,
      );
    },
  );
  await check(
    "model cancellation during page execution reaches SDK AbortSignal and rejects late result",
    async () => {
      const offset = env.events.history.length;
      const after = await begin("model-execution-cancel");
      await env.agent.respond(await permission("model-execution-cancel"), "allow");
      await page("window.waitPageCall('model-execution-cancel')");
      await command("stop", {});
      await page("window.waitPageAbort('model-execution-cancel')");
      const result = await env.events.wait((e) => e.type === "resolveAppToolCall", offset);
      assert.equal(result.result.accepted, false);
      await terminal(after);
      await page("window.releasePageCall('model-execution-cancel')");
      assert.equal(
        await page("window.pageCalls.filter(c => c.key === 'model-execution-cancel').length"),
        1,
      );
      assert.equal((await ui("window.managedState()")).busy, false);
    },
  );
  await check("model target stays bound when retry replaces page during approval", async () => {
    const old = env.handles.get(win.webContents.id).instance;
    const after = await begin("model-replaced");
    const pending = await permission("model-replaced");
    const offset = env.events.history.length;
    await ui("window.retryManaged()");
    await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
    await page("window.fixtureReady");
    await env.agent.respond(pending, "allow");
    await terminal(after);
    assert.notEqual(env.handles.get(win.webContents.id).instance.token, old.token);
    assert.deepEqual(await page("window.pageCalls"), []);
  });
}
