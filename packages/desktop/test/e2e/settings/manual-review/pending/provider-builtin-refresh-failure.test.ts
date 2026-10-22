import { createServer, request as forwardRequest } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS as ids } from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  seedSettings,
} from "../../../helpers/desktop-app.js";
import {
  readBigModelConnectionSelection,
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelStartPlanCredential,
} from "../../../helpers/model-provider-restart.js";
import {
  getV4ModelConfig,
  prepareV4ConversationE2E,
  switchV4Model,
} from "../../../helpers/v4-conversation.js";

describe("Builtin 下载失败时的套餐操作", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BR117-F01：有效本地配置保留 Team 切换和 Start 模型选择", async function () {
    this.timeout(180_000);
    const upstream = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL;
    if (!upstream) throw new Error("Missing isolated account control plane");
    const paths = getE2EAppDataPaths();
    let controlRequests = 0;
    let downloadRequests = 0;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/api/v1/client/configs") {
        controlRequests++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              configs: { builtin_provider_config_json: `http://127.0.0.1:${port}/builtin.json` },
            },
          }),
        );
        return;
      }
      if (path === "/builtin.json") {
        downloadRequests++;
        response.writeHead(500).end();
        return;
      }
      // 仅替换远端配置响应；权益、项目身份等仍走既有隔离账号控制面。
      const forwarded = forwardRequest(
        new URL(request.url ?? "/", upstream),
        {
          method: request.method,
          headers: { ...request.headers, host: new URL(upstream).host },
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      forwarded.on("error", () => response.writeHead(502).end());
      request.pipe(forwarded);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing control port");
    const port = address.port;
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      const scenario = await fetch(`${upstream}/__e2e/coding-plan/scenario`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "both", providerResponsive: true }),
      });
      expect(scenario.ok).toBe(true);
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          await seedBigModelStartPlanCredential();
          await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
          await seedSettings({ zcodeEndpointOrigin: `http://127.0.0.1:${port}` });
        },
      });
      await browser.waitUntil(() => controlRequests > 0, {
        timeout: 30_000,
        timeoutMsg: "正式下载器没有请求隔离控制面",
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(
        testId(TID_MODEL_PROVIDER_NAV_ITEM, `preset:${ids.bigmodelStartPlan}`),
      );
      const logsBeforeSwitch = (await readRuntimeLogs(paths.appDataDir)).length;
      await clickTestIdByDom(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER);
      await clickTestIdByDom(
        testId(
          TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
          "team:bigmodel:product-team-a:org-team-a:proj-team-a",
        ),
      );
      // 等待真实刷新 RPC 成功，避免只看保存中间态，遗漏后续回滚。
      await browser.waitUntil(
        async () => {
          const logs = (await readRuntimeLogs(paths.appDataDir)).slice(logsBeforeSwitch);
          return (
            logs.includes("Builtin 远端更新失败，继续使用本地配置") &&
            logs.includes("provider-settings.refresh OK")
          );
        },
        { timeout: 20_000, timeoutMsg: "远端更新失败仍导致业务刷新 RPC 失败" },
      );
      const team = {
        kind: "team-coding-plan",
        productId: "product-team-a",
        organizationId: "org-team-a",
        projectId: "proj-team-a",
      };
      expect(await readBigModelConnectionSelection()).toEqual(team);
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      await switchV4Model(ids.bigmodelTeamCodingPlan, "GLM-5.3", "high");
      expect(await getV4ModelConfig()).toMatchObject({
        provider: ids.bigmodelTeamCodingPlan,
        model: "GLM-5.3",
      });
      await switchV4Model(ids.bigmodelStartPlan, "GLM-5-Turbo", "enabled");
      expect(await getV4ModelConfig()).toMatchObject({
        provider: ids.bigmodelStartPlan,
        model: "GLM-5-Turbo",
      });
      expect(await readBigModelConnectionSelection()).toEqual(team);
      expect(downloadRequests).toBe(0);
      const artifacts = join(
        process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts"),
        "builtin-refresh-failure",
      );
      await mkdir(artifacts, { recursive: true });
      await browser.saveScreenshot(join(artifacts, "start-model-after-team-switch.png"));
      await writeFile(
        join(artifacts, "assertions.json"),
        JSON.stringify(
          { controlRequests, downloadRequests, team, selection: await getV4ModelConfig() },
          null,
          2,
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function readRuntimeLogs(configDir: string): Promise<string> {
  const dir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() || join(configDir, "logs");
  const files = await readdir(dir).catch(() => []);
  return (
    await Promise.all(
      files
        .filter((name) => name.endsWith(".log"))
        .map((name) => readFile(join(dir, name), "utf8")),
    )
  ).join("\n");
}
