import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";

const [root, profile, node, cli, serverScript] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const env = await managedEnvironment(root, node, cli);
    const checks: string[] = [];
    try {
      // 独立 fixture 只批准本测试的两个演示工具；审批仍通过真实 Agent/宿主链路。
      env.agent.client.onRequest((request) => {
        const input = (request.params as any)?.input;
        if (
          request.method === "interaction/requestPermission" &&
          (input?.durationMs === 10_000 ||
            input?.filter === "all" ||
            String(input?.key).startsWith("showcase-page"))
        )
          void env.agent.respond(request, "allow");
      });
      const scope = await env.agent.session(
        join(root, "showcase-workspace"),
        "showcase",
        "showcase",
        undefined,
        {
          serverScript,
          resourceUri: "ui://showcase/cases.html",
        },
      );
      await env.agent.call("session/setModel", {
        sessionId: scope.sessionId,
        model: env.model.selection,
      });
      const win = await env.createWindow(scope, "sampling");
      const page = (code: string) => env.evalPage(win, code);
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      const click = (id: string) => page(`document.getElementById(${JSON.stringify(id)}).click()`);
      const value = (id: string, text: string) =>
        page(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(text)}`);
      const read = (id: string) =>
        page(`document.getElementById(${JSON.stringify(id)}).textContent`);
      // DOM 事件驱动观察实际按钮处理的终态，不用睡眠代替请求完成。
      const phase = (id: string, wanted: string) =>
        page(`new Promise(resolve => {
      const node=document.getElementById(${JSON.stringify(id)});
      const check=()=>{if(node.dataset.phase===${JSON.stringify(wanted)}){observer.disconnect();resolve(node.textContent)}};
      const observer=new MutationObserver(check);observer.observe(node,{attributes:true,childList:true,subtree:true});check();
    })`);
      const check = async (name: string, run: () => Promise<void>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            run(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 20_000);
            }),
          ]);
          checks.push(name);
          process.stdout.write(`PASS Showcase ${name}\n`);
        } finally {
          clearTimeout(timer);
        }
      };
      await check("built HTML connects once and all 53 cases have reachable details", async () => {
        assert.equal(await page("document.querySelectorAll('[data-case-id]').length"), 53);
        assert.match(await read("connection"), /Connected|已连接/);
        assert.equal(await page("document.querySelectorAll('[data-case-id]').length"), 53);
        for (let index = 1; index <= 53; index++) {
          const id = `SC${String(index).padStart(2, "0")}`;
          await page(`document.querySelector('[data-case-id="${id}"]').click()`);
          assert.match(await read("case-detail"), new RegExp(id));
        }
        await value("case-mode", "pending");
        await page("document.getElementById('case-mode').dispatchEvent(new Event('change'))");
        assert.equal(await page("document.querySelectorAll('[data-case-id]').length"), 2);
        assert.equal(await page("document.getElementById('send-demo').disabled"), true);
        await value("case-mode", "all");
        await page("document.getElementById('case-mode').dispatchEvent(new Event('change'))");
      });
      await check("page heap, input, local scroll and guest survive twenty moves", async () => {
        const boot = await read("boot-id");
        const guest = env.guests.get(win.webContents.id)!.id;
        await click("heap-bump");
        await value("heap-input", "retained by the actual Showcase page");
        await page("document.getElementById('heap-scroll').scrollTop=90");
        for (let i = 0; i < 20; i++) await ui(`window.setAnchors(${i % 2 !== 0},${i % 2 === 0})`);
        assert.equal(env.guests.get(win.webContents.id)!.id, guest);
        assert.equal(await read("boot-id"), boot);
        assert.equal(await read("heap-count"), "1");
        assert.equal(
          await page("document.getElementById('heap-input').value"),
          "retained by the actual Showcase page",
        );
        assert.equal(await page("document.getElementById('heap-scroll').scrollTop"), 90);
      });
      await check(
        "real storage buttons round-trip, rebuild and delete only lab samples",
        async () => {
          await value("storage-value", "persistent sample");
          await click("storage-write");
          assert.deepEqual(JSON.parse(await phase("storage-result", "complete")), {
            localStorage: "persistent sample",
            indexedDB: "persistent sample",
          });
          const oldBoot = await read("boot-id");
          const oldGuest = env.guests.get(win.webContents.id)!;
          const destroyed = new Promise<void>((resolve) => oldGuest.once("destroyed", resolve));
          await ui("window.retryManaged()");
          await destroyed;
          await ui("window.waitManagedPhase('running')");
          await page("window.showcaseReady");
          assert.notEqual(await read("boot-id"), oldBoot);
          await click("storage-read");
          assert.deepEqual(JSON.parse(await phase("storage-result", "complete")), {
            localStorage: "persistent sample",
            indexedDB: "persistent sample",
          });
          await click("storage-delete");
          assert.deepEqual(JSON.parse(await phase("storage-result", "complete")), {
            localStorage: null,
            indexedDB: null,
          });
        },
      );
      await check(
        "actual App long-tool button cancels through Agent and can complete a new call",
        async () => {
          const after = env.events.history.length;
          await click("check-start");
          await phase("check-status", "running");
          await click("check-cancel");
          await phase("check-status", "cancelled");
          await env.events.wait(
            (event) => event.type === "bridge" && event.method === "cancelToolCall",
            after,
          );
          await click("check-start");
          assert.match(await phase("check-status", "complete"), /completed/);
        },
      );
      const before = await env.agent.call("session/read", { sessionId: scope.sessionId });
      await check(
        "sampling buttons send completed page history and demo image, not main chat",
        async () => {
          for (let i = 0; i < 2; i++) {
            env.model.plans.push({ key: `showcase-${i}`, delayed: false });
            await value("sampling-prompt", `question ${i}`);
            if (i === 1) await click("sampling-image");
            await click("sampling-send");
            assert.match(await phase("sampling-status", "complete"), /gpt-4o/);
            assert.equal(env.model.requests.history.at(-1).body.messages.length, i * 2 + 1);
          }
          assert.match(
            JSON.stringify(env.model.requests.history.at(-1).body.messages),
            /data:image\/png;base64/,
          );
          assert.match(await read("sampling-history"), /answer:showcase-1/);
          const after = await env.agent.call("session/read", { sessionId: scope.sessionId });
          assert.deepEqual(after.messages, before.messages);
          await click("sampling-reset");
          assert.equal(await read("sampling-history"), "");
        },
      );
      await check(
        "actual sampling cancellation aborts provider and excludes failed history",
        async () => {
          env.model.plans.push({ key: "showcase-cancel", delayed: true });
          await value("sampling-prompt", "cancel this request");
          await click("sampling-send");
          await env.model.requests.wait((event) => event.plan?.key === "showcase-cancel");
          await click("sampling-cancel");
          await phase("sampling-status", "cancelled");
          await env.model.aborted.wait((key) => key === "showcase-cancel");
          env.model.release("showcase-cancel");
          assert.equal(await read("sampling-history"), "");
        },
      );
      await check("unsupported sampling controls reject before reaching the provider", async () => {
        const requests = env.model.requests.history.length;
        for (const invalid of ["temperature", "tools", "audio"]) {
          await value("sampling-invalid", invalid);
          await click("sampling-reject");
          await phase("sampling-status", "rejected");
        }
        assert.equal(env.model.requests.history.length, requests);
        assert.equal(await read("sampling-history"), "");
      });
      await check(
        "failure controls prepare the selected model tool without sending automatically",
        async () => {
          await value("failure-mode", "fullscreen");
          await click("failure-throw");
          await click("failure-prepare");
          const prompt = await page("document.getElementById('demo-prompt').value");
          assert.match(prompt, /show_failure_fullscreen/);
          assert.match(prompt, /"throwError":true/);
        },
      );
      await check(
        "live host context switches Chinese/dark at 320px without horizontal overflow",
        async () => {
          const boot = await read("boot-id");
          await ui("window.setShowcasePresentation('dark','zh-CN',320)");
          assert.equal(await page("document.documentElement.lang"), "zh-CN");
          assert.equal(await page("document.documentElement.style.colorScheme"), "dark");
          assert.equal(
            await page("getComputedStyle(document.body).backgroundColor"),
            "rgb(23, 25, 28)",
          );
          assert.match(await read("connection"), /已连接/);
          assert.match(await read("case-detail"), /SC35/);
          assert.match(await read("sampling-capability"), /宿主声明/);
          assert.equal(await read("boot-id"), boot);
          assert.equal(
            await page("document.documentElement.scrollWidth <= window.innerWidth"),
            true,
          );
          await writeFile(
            join(root, "showcase-dark-320.png"),
            (await win.webContents.capturePage()).toPNG(),
          );
          await ui("window.setShowcasePresentation('light','en-US',400)");
        },
      );
      await check(
        "real model discovers page tool, completes on click and cancels without changing the note",
        async () => {
          const command = (type: string, payload: unknown) =>
            env.agent.call("v4/command", {
              commandId: randomUUID(),
              clientId: "showcase-e2e",
              sessionId: scope.sessionId,
              type,
              payload,
              issuedAt: Date.now(),
            });
          for (const cancel of [false, true]) {
            const key = cancel ? "showcase-page-cancel" : "showcase-page-complete";
            const after = env.agent.notifications.history.length;
            env.model.plans.push({ key, delayed: true });
            const ack = await command("sendText", {
              text: key,
              modelSelection: env.model.selection,
              mode: "build",
            });
            assert.equal(ack.status, "accepted");
            await phase("page-tool-status", "running");
            if (cancel) {
              await command("stop", {});
              await phase("page-tool-status", "cancelled");
            } else {
              await click("page-tool-finish");
              await phase("page-tool-status", "complete");
            }
            await env.agent.notifications.wait(
              (event) =>
                event.method === "v4/telemetry/event" &&
                event.params.kind === "turn.terminal" &&
                event.params.sessionId === scope.sessionId,
              after,
            );
            assert.equal(await read("page-note"), "showcase-page-complete");
          }
        },
      );
      await check(
        "legacy dashboard still handshakes and its real refresh button renders four services",
        async () => {
          const legacy = await env.createWindow(
            { ...scope, resourceUri: "ui://showcase/dashboard.html" },
            "sampling",
          );
          await env.evalPage(legacy, "window.zcode.ready()");
          await env.evalPage(
            legacy,
            `document.getElementById('refresh').click(); new Promise(resolve => {
        const rows=document.getElementById('rows');const check=()=>{if(rows.children.length===4){observer.disconnect();resolve(true)}};
        const observer=new MutationObserver(check);observer.observe(rows,{childList:true});check();
      })`,
          );
          assert.equal(
            await env.evalPage(legacy, "document.querySelectorAll('#rows tr').length"),
            4,
          );
          assert.equal(await env.evalPage(legacy, "typeof window.openai.callTool"), "function");
          await env.evalPage(
            legacy,
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          await writeFile(
            join(root, "showcase-legacy.png"),
            (await legacy.webContents.capturePage()).toPNG(),
          );
        },
      );
      await writeFile(
        join(root, "showcase-lab.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await writeFile(
        join(root, "showcase-results.json"),
        JSON.stringify(
          {
            checks,
            modelRequests: env.model.requests.history.length,
            approvals: env.agent.approvals.history.length,
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
