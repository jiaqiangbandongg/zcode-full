import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
import { checkPermissions } from "./managed-permission-checks.js";
import { checkLifecycle } from "./managed-lifecycle-checks.js";
import { checkManaged } from "./managed-checks.js";
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const env = await managedEnvironment(root, node, cli);
    const checks: { name: string; ms: number }[] = [];
    const check = async (name: string, run: () => Promise<void>) => {
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out: ${name}`)),
              name.includes("keep-warm") ? 45_000 : 20_000,
            );
          }),
        ]);
      } catch (error) {
        await writeFile(
          join(root, "managed-failure.json"),
          JSON.stringify(
            {
              name,
              requests: env.model.requests.history,
              approvals: env.agent.approvals.history,
              events: env.events.history.slice(-20),
              notifications: env.agent.notifications.history.slice(-12),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        clearTimeout(timer!);
      }
      checks.push({ name, ms: performance.now() - start });
      process.stdout.write(`PASS ${name}\n`);
    };
    try {
      const scope = await env.agent.session(join(root, "managed-workspace"), "managed");
      const started = performance.now();
      const win = await env.createWindow(scope);
      const coldPageMs = performance.now() - started;
      await writeFile(
        join(root, "managed-inline.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await check(
        "production React card and managed page establish one live conversation lease",
        async () => {
          const state = await win.webContents.executeJavaScript("window.managedState()");
          assert.equal(state.phase, "running");
          assert.equal(state.views, 1);
          assert.equal(state.listeners.frame, 1);
          assert.equal(env.events.history.filter((e) => e.type === "subscribed").length, 1);
        },
      );
      await checkManaged(env, win, scope, check);
      await checkPermissions(env, root, check);
      await checkLifecycle(env, win, scope, check);
      await writeFile(
        join(root, "managed-storage-identity.json"),
        JSON.stringify({ appIdentity: env.handles.get(win.webContents.id).instance.appIdentity }),
      );
      await writeFile(
        join(root, "managed-results.json"),
        JSON.stringify({ coldPageMs, checks }, null, 2),
      );
    } finally {
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
