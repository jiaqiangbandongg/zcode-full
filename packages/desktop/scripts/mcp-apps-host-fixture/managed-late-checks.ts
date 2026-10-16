import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
export async function checkLate(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  await check(
    "retry while prepare reply is withheld discards old handle and serializes replacement",
    async () => {
      const offset = env.events.history.length;
      const gate = Promise.withResolvers<void>();
      env.gates.set("return:prepareSandbox", gate.promise);
      await ui("window.retryManaged()");
      await env.events.wait((e) => e.type === "bridge" && e.method === "prepareSandbox", offset);
      const stale = env.handles.get(win.webContents.id);
      await ui("window.retryManaged(); window.retryManaged()");
      assert.equal(
        env.events.history.slice(offset).filter((e) => e.type === "registered").length,
        1,
      );
      env.gates.delete("return:prepareSandbox");
      gate.resolve();
      await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
      await env.evalPage(win, "window.fixtureReady");
      const replacement = env.handles.get(win.webContents.id);
      assert.notEqual(replacement.instance.token, stale.instance.token);
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: stale.instance }),
      );
      await ui(`window.harness.dispose(${JSON.stringify(stale.sandboxId)}, ${stale.initId})`);
      assert.equal(env.countGuests(), 1);
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
  await check("late project-wide permission answer cannot grant replacement page", async () => {
    const oldCall = env
      .evalPage(win, "window.callTool('project-stale')")
      .catch((error) => ({ error: String(error) }));
    const pending = await env.agent.approvals.wait((r) => r.params.input?.key === "project-stale");
    const project = pending.params.options.find(
      (option: any) => option.optionId === "allow_project",
    );
    assert.ok(project?.response.permissionUpdates?.length);
    const offset = env.events.history.length;
    await ui("window.retryManaged()");
    await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
    await env.evalPage(win, "window.fixtureReady");
    await env.agent.client.respond(pending.id, project.response);
    assert.ok((await oldCall).error);
    const next = env.evalPage(win, "window.callTool('project-replacement')");
    const nextPermission = await env.agent.approvals.wait(
      (r) => r.params.input?.key === "project-replacement",
    );
    await env.agent.respond(nextPermission, "deny");
    assert.ok((await next).error);
    assert.equal(
      env.agent.events.history.some((e) => e.type === "executed" && e.key.startsWith("project-")),
      false,
    );
  });
  await check(
    "withheld app tool registration cannot resurrect replaced page or unregister its successor",
    async () => {
      const offset = env.events.history.length;
      const gate = Promise.withResolvers<void>();
      env.gates.set("registerAppTools", gate.promise);
      await ui("window.retryManaged()");
      await env.events.wait(
        (e) => e.type === "app-tools-arrived" && e.method === "registerAppTools",
        offset,
      );
      const stale = env.handles.get(win.webContents.id).instance;
      env.gates.delete("registerAppTools");
      const after = env.events.history.length;
      await ui("window.retryManaged()");
      const registered = await env.events.wait((e) => e.type === "registerAppTools", after);
      assert.notEqual(registered.params.instance.token, stale.token);
      gate.resolve();
      await env.evalPage(win, "window.fixtureReady");
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: stale }),
      );
      assert.equal(env.countGuests(), 1);
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
}
