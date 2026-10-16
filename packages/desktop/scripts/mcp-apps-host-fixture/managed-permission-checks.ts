import assert from "node:assert/strict";
import { dialog } from "electron";
import { join } from "node:path";
import { Events } from "./agent.js";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
export async function checkPermissions(
  env: Environment,
  root: string,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  await check(
    "native permission prompt binds real guest and stale Allow cannot authorize replacement",
    async () => {
      const scope = await env.agent.session(
        join(root, "permissions-workspace"),
        "managed-permissions",
      );
      const win = await env.createWindow(scope);
      const prompts = new Events<{
        resolve: (value: { response: number; checkboxChecked: boolean }) => void;
      }>();
      const original = dialog.showMessageBox;
      // 只替代原生确认框的用户回答；Chromium 请求、frame 绑定及权限 gate 均为生产代码。
      dialog.showMessageBox = (() =>
        new Promise((resolve) => prompts.emit({ resolve }))) as typeof original;
      const request = () =>
        env
          .evalPage(
            win,
            "new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('granted'), error => resolve(error.code)))",
          )
          .catch((error) => String(error));
      try {
        const first = request();
        const prompt = await prompts.wait(() => true);
        const offset = env.events.history.length;
        await win.webContents.executeJavaScript("window.retryManaged()");
        await env.events.wait(
          (e) => e.type === "phase" && e.phase === "running" && e.owner === win.webContents.id,
          offset,
        );
        await env.evalPage(win, "window.fixtureReady");
        prompt.resolve({ response: 0, checkboxChecked: false });
        assert.notEqual(await first, "granted");
        const second = request();
        const replacementPrompt = await prompts.wait(() => true, 1);
        replacementPrompt.resolve({ response: 1, checkboxChecked: false });
        assert.equal(await second, 1);
        assert.equal(prompts.history.length, 2);
        const camera = await env.evalPage(
          win,
          "navigator.permissions.query({name:'camera'}).then(status => status.state)",
        );
        assert.equal(camera, "denied");
        assert.equal(prompts.history.length, 2);
      } finally {
        dialog.showMessageBox = original;
        win.destroy();
      }
    },
  );
}
