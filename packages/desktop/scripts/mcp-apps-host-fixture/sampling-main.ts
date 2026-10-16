import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { checkSamplingExtras } from "./sampling-extra-checks.js";
import { managedEnvironment } from "./managed-environment.js";

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
        checks.push({ name, ms: performance.now() - start });
        process.stdout.write(`PASS ${name}\n`);
      } catch (error) {
        await writeFile(
          join(root, "sampling-failure.json"),
          JSON.stringify(
            {
              name,
              requests: env.model.requests.history,
              approvals: env.agent.approvals.history,
              events: env.events.history.slice(-20),
              notifications: env.agent.notifications.history.slice(-10),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        clearTimeout(timer!);
      }
    };
    try {
      const scope = await env.agent.session(join(root, "sampling-workspace"), "sampling");
      await env.agent.call("session/setModel", {
        sessionId: scope.sessionId,
        model: env.model.selection,
      });
      const started = performance.now();
      const win = await env.createWindow(scope, "sampling");
      const coldPageMs = performance.now() - started;
      const page = (code: string) => env.evalPage(win, code);
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      const request = {
        messages: [{ role: "user", content: { type: "text", text: "What is 1 + 1?" } }],
        maxTokens: 128,
      };
      const sample = (key: string, params: any = request) =>
        page(`window.sample(${JSON.stringify(key)},${JSON.stringify(params)})`);
      const binding = (operationId: string) => ({
        ...scope,
        instance: env.handles.get(win.webContents.id).instance,
        operationId,
      });
      const mainBefore = await env.agent.call("session/read", { sessionId: scope.sessionId });
      await check(
        "official SDK sampling capability and app-owned three-round conversation",
        async () => {
          assert.deepEqual((await page("window.samplingCapabilities()")).sampling, {});
          const messages: any[] = [];
          for (let i = 0; i < 3; i++) {
            const key = `round-${i}`;
            messages.push({ role: "user", content: { type: "text", text: `question ${i}` } });
            env.model.plans.push({ key, delayed: false });
            const reply = await sample(key, { ...request, messages });
            assert.equal(reply.result.content.text, `answer:${key}`);
            assert.equal(reply.result.model, "gpt-4o");
            assert.equal(reply.result.stopReason, "endTurn");
            messages.push({ role: "assistant", content: reply.result.content });
            const sent = env.model.requests.history.at(-1).body;
            assert.equal(sent.messages.length, i * 2 + 1);
            assert.equal(sent.tools, undefined);
          }
          assert.equal(env.agent.approvals.history.length, 0);
          const after = await env.agent.call("session/read", { sessionId: scope.sessionId });
          assert.deepEqual(after.messages, mainBefore.messages);
          await ui("window.waitSamplingIdle()");
          assert.equal((await ui("window.managedState()")).busy, false);
        },
      );
      await check(
        "text plus image, explicit system prompt, token limit, advisory model hints",
        async () => {
          const image = {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
          };
          const reply = await sample("image", {
            ...request,
            messages: [{ role: "user", content: [request.messages[0].content, image] }],
            systemPrompt: "Teach basic maths.",
            maxTokens: 17,
            modelPreferences: { hints: [{ name: "unavailable-model" }] },
            includeContext: "none",
          });
          assert.equal(reply.result.model, "gpt-4o");
          const sent = env.model.requests.history.at(-1).body;
          assert.equal(sent.model, "gpt-4o");
          assert.equal(sent.messages[0].content, "Teach basic maths.");
          assert.ok(JSON.stringify(sent.messages).includes(`data:image/png;base64,${image.data}`));
          assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 17);
        },
      );
      await check(
        "unsupported content/options and non-actionable task fail before provider",
        async () => {
          const count = env.model.requests.history.length;
          for (const invalid of [
            { temperature: 0.5 },
            { stopSequences: ["END"] },
            { includeContext: "allServers" },
            { tools: [] },
            {
              messages: [
                { role: "user", content: { type: "audio", mimeType: "audio/wav", data: "AAAA" } },
              ],
            },
          ]) {
            assert.ok(
              (await sample("invalid", { ...request, ...invalid })).error,
              JSON.stringify(invalid),
            );
          }
          await ui("window.setSamplingEnabled(false)");
          assert.ok((await sample("read-only")).error);
          await ui("window.setSamplingEnabled(true)");
          assert.equal(env.model.requests.history.length, count);
          // 官方 SDK 在宿主 handler 前过滤非协议字段；它们不能覆盖绑定模型。
          assert.equal(
            (await sample("ignored-provider", { ...request, providerId: "other" })).result.model,
            "gpt-4o",
          );
          await assert.rejects(() =>
            env.agent.call("mcp/uiSampling", {
              ...binding("injected-provider"),
              request: { ...request, providerId: "other" },
            }),
          );
        },
      );
      await check("SDK cancellation aborts HTTP, frees busy state, and never replays", async () => {
        env.model.plans.push({ key: "cancel", delayed: true });
        const result = sample("cancel");
        await env.model.requests.wait((e) => e.plan?.key === "cancel");
        await page("window.cancelSample('cancel')");
        assert.ok((await result).error);
        await env.model.aborted.wait((key) => key === "cancel");
        await env.events.wait((e) => e.type === "bridge" && e.method === "cancelSampling");
        env.model.release("cancel");
        assert.equal(env.model.requests.history.filter((e) => e.plan?.key === "cancel").length, 1);
      });
      await check(
        "pending sampling survives twenty inline-sidebar moves and prevents recycle",
        async () => {
          env.model.plans.push({ key: "move", delayed: true });
          const result = sample("move");
          await env.model.requests.wait((e) => e.plan?.key === "move");
          const guestId = env.guests.get(win.webContents.id)!.id;
          const before = await ui("window.managedState()");
          const reads = env.agent.events.history.filter((e) => e.type === "read").length;
          assert.equal(before.busy, true);
          assert.equal(await ui("window.suspendManaged()"), false);
          assert.ok((await sample("concurrent")).error);
          for (let i = 0; i < 20; i++) await ui(`window.setAnchors(${i % 2 === 0},${i % 2 !== 0})`);
          const after = await ui("window.managedState()");
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          assert.deepEqual(after.handle, before.handle);
          assert.deepEqual(after.listeners, before.listeners);
          assert.equal(after.views, 1);
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, reads);
          env.model.release("move");
          assert.equal((await result).result.content.text, "answer:move");
          await ui("window.waitSamplingIdle()");
          assert.equal((await ui("window.managedState()")).busy, false);
        },
      );
      await check(
        "Agent pre-admission cancellation, duplicate operation and forged credential",
        async () => {
          const before = env.model.requests.history.length;
          const cancelled = binding("cancel-before");
          assert.equal((await env.agent.call("mcp/uiCancelSampling", cancelled)).cancelled, false);
          await assert.rejects(() => env.agent.call("mcp/uiSampling", { ...cancelled, request }));
          const complete = binding("complete-once");
          await env.agent.call("mcp/uiSampling", { ...complete, request });
          await assert.rejects(() => env.agent.call("mcp/uiSampling", { ...complete, request }));
          assert.equal((await env.agent.call("mcp/uiCancelSampling", complete)).cancelled, false);
          await assert.rejects(() =>
            env.agent.call("mcp/uiSampling", {
              ...binding("forged"),
              instance: { ...complete.instance, token: "forged" },
              request,
            }),
          );
          await assert.rejects(() =>
            env.agent.call("mcp/uiSampling", {
              ...binding("wrong-server"),
              serverName: "different",
              request,
            }),
          );
          assert.equal(env.model.requests.history.length, before + 1);
        },
      );
      await check(
        "current model is frozen for admitted request and changes on the next call",
        async () => {
          env.model.plans.push({ key: "model-change", delayed: true });
          const result = sample("model-change");
          await env.model.requests.wait((e) => e.plan?.key === "model-change");
          await env.agent.call("session/setModel", {
            sessionId: scope.sessionId,
            model: { ...env.model.selection, modelId: "gpt-4o-mini" },
          });
          env.model.release("model-change");
          assert.equal((await result).result.model, "gpt-4o");
          assert.equal((await sample("new-model")).result.model, "gpt-4o-mini");
          assert.equal(env.model.requests.history.at(-1).body.model, "gpt-4o-mini");
        },
      );
      await check(
        "same source in another window isolates credentials and cancellation",
        async () => {
          const second = await env.createWindow(scope, "sampling");
          env.model.plans.push({ key: "isolated", delayed: true });
          const result = sample("isolated");
          await env.model.requests.wait((e) => e.plan?.key === "isolated");
          assert.notEqual(
            env.handles.get(second.webContents.id).instance.token,
            binding("unused").instance.token,
          );
          const reply = await env.evalPage(
            second,
            `window.sample('second',${JSON.stringify(request)})`,
          );
          assert.ok(reply.result);
          const guest = env.guests.get(second.webContents.id)!;
          const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
          await second.webContents.executeJavaScript(
            "window.setAnchors(false,false).then(() => window.clearManaged())",
          );
          await destroyed;
          second.destroy();
          assert.equal((await ui("window.managedState()")).busy, true);
          env.model.release("isolated");
          assert.equal((await result).result.content.text, "answer:isolated");
        },
      );
      await check(
        "finish reason is preserved and sampling never appends main conversation",
        async () => {
          env.model.plans.push({ key: "length", delayed: false, finishReason: "length" });
          assert.equal((await sample("length")).result.stopReason, "maxTokens");
          const after = await env.agent.call("session/read", { sessionId: scope.sessionId });
          assert.deepEqual(after.messages, mainBefore.messages);
          assert.equal(env.agent.approvals.history.length, 0);
          const forbidden = env.agent.notifications.history.filter((e) =>
            /ModelRequest|ModelComplete|model_request/.test(JSON.stringify(e)),
          );
          assert.equal(forbidden.length, 0);
        },
      );
      await check(
        "connection revocation aborts provider and rejects the old credential",
        async () => {
          env.model.plans.push({ key: "revoke", delayed: true });
          const result = sample("revoke");
          await env.model.requests.wait((e) => e.plan?.key === "revoke");
          const old = binding("old");
          env.agent.disconnect("sampling");
          assert.ok((await result).error);
          await env.model.aborted.wait((key) => key === "revoke");
          await assert.rejects(() => env.agent.call("mcp/uiSampling", { ...old, request }));
        },
      );
      await check(
        "window teardown releases guests, feeds, and listeners after existing keep-warm deadline",
        async () => {
          await ui(
            "window.setAnchors(false,false).then(() => { window.clearManaged(); return window.waitConnectionsReleased(); })",
          );
          win.destroy();
          assert.equal(env.countGuests(), 0);
        },
      );
      await checkSamplingExtras(env, root, check);
      await writeFile(
        join(root, "sampling-results.json"),
        JSON.stringify(
          {
            coldPageMs,
            checks,
            modelRequests: env.model.requests.history.length,
            approvals: env.agent.approvals.history.length,
            remainingGuests: env.countGuests(),
          },
          null,
          2,
        ),
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
