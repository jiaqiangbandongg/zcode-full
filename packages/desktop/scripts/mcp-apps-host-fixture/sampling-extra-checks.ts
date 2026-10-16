import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
export async function checkSamplingExtras(
  env: Environment,
  root: string,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  const request = {
    messages: [{ role: "user", content: { type: "text", text: "Explain 1/2" } }],
    maxTokens: 32,
  };
  const scope = await env.agent.session(join(root, "sampling-extra-workspace"), "sampling-extra");
  await env.agent.call("session/setModel", {
    sessionId: scope.sessionId,
    model: env.model.selection,
  });
  const win = await env.createWindow(scope, "sampling");
  const page = (code: string) => env.evalPage(win, code);
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  const sample = (key: string) =>
    page(`window.sample(${JSON.stringify(key)},${JSON.stringify(request)})`);
  await check(
    "task permission modes reuse the same sampling path without extra approval",
    async () => {
      const before = env.agent.approvals.history.length;
      for (const mode of ["plan", "build", "edit", "yolo"]) {
        await env.agent.call("session/setMode", { sessionId: scope.sessionId, mode });
        assert.ok((await sample(`mode-${mode}`)).result);
      }
      assert.equal(env.agent.approvals.history.length, before);
      assert.equal(
        (await env.agent.call("session/read", { sessionId: scope.sessionId })).messages.length,
        0,
      );
      const usage = await env.agent.call("session/usage", { sessionId: scope.sessionId });
      assert.ok(usage.modelRequestCount >= 4);
      assert.ok(usage.totalTokens >= 60);
    },
  );
  await check(
    "provider error reaches SDK once and releases the instance for the next call",
    async () => {
      env.model.plans.push({ key: "failed", delayed: false, status: 401 });
      assert.ok((await sample("failed")).error);
      await ui("window.waitSamplingIdle()");
      assert.equal(env.model.requests.history.filter((e) => e.plan?.key === "failed").length, 1);
      assert.ok((await sample("after-error")).result);
    },
  );
  await check(
    "sampling and the main task run concurrently with independent cancellation",
    async () => {
      env.model.plans.push({ key: "parallel-sampling", delayed: true });
      const sampling = sample("parallel-sampling");
      await env.model.requests.wait((e) => e.plan?.key === "parallel-sampling");
      const offset = env.agent.notifications.history.length;
      const ack = await env.agent.call("v4/command", {
        commandId: randomUUID(),
        clientId: "sampling-fixture",
        sessionId: scope.sessionId,
        type: "sendText",
        payload: {
          text: "A main conversation question",
          modelSelection: env.model.selection,
          mode: "build",
        },
        issuedAt: Date.now(),
      });
      assert.equal(ack.status, "accepted");
      const terminal = await env.agent.notifications.wait(
        (e) =>
          e.method === "v4/telemetry/event" &&
          e.params.kind === "turn.terminal" &&
          e.params.sessionId === scope.sessionId,
        offset,
      );
      assert.equal(terminal.params.status, "success");
      assert.equal((await ui("window.managedState()")).busy, true);
      const before = await env.agent.call("session/read", { sessionId: scope.sessionId });
      assert.ok(before.messages.length > 0);
      await page("window.cancelSample('parallel-sampling')");
      assert.ok((await sampling).error);
      await env.model.aborted.wait((key) => key === "parallel-sampling");
      assert.deepEqual(
        (await env.agent.call("session/read", { sessionId: scope.sessionId })).messages,
        before.messages,
      );
    },
  );
  await check(
    "closing task aborts sampling, rejects stale requests and releases keep-warm subscriptions",
    async () => {
      env.model.plans.push({ key: "close-task", delayed: true });
      const result = sample("close-task").catch(() => ({ error: "page closed" }));
      await env.model.requests.wait((e) => e.plan?.key === "close-task");
      const instance = env.handles.get(win.webContents.id).instance;
      await env.agent.call("session/close", { sessionId: scope.sessionId });
      assert.ok((await result).error);
      await env.model.aborted.wait((key) => key === "close-task");
      await assert.rejects(() =>
        env.agent.call("mcp/uiSampling", {
          ...scope,
          instance,
          operationId: "after-close",
          request,
        }),
      );
      await ui(
        "window.setAnchors(false,false).then(() => { window.clearManaged(); return window.waitConnectionsReleased(); })",
      );
      win.destroy();
    },
  );
}
