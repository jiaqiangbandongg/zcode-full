import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "@zcode/adapters/auth";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createZCodeApp } from "../src/app/create-app.js";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";

const OUTPUT_BUDGET = 24_000;
const builtinPath = fileURLToPath(
  new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
);

describe("CLI 旧输出上限从首次导入到请求", () => {
  it.each([
    { kind: "anthropic", field: "max_tokens", legacy: { maxOutputTokens: OUTPUT_BUDGET } },
    {
      kind: "openai-compatible",
      field: "max_completion_tokens",
      legacy: { options: { max_tokens: OUTPUT_BUDGET } },
    },
    { kind: "openai", field: "max_output_tokens", legacy: { limit: { output: OUTPUT_BUDGET } } },
  ])(
    "$kind 保留预算、继承 map，重启不重读旧配置",
    async ({ kind, field, legacy }) => {
      const directory = await mkdtemp(join(tmpdir(), "cli-output-migration-"));
      const requests: Record<string, unknown>[] = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        // 本地服务只捕获真实 SDK wire；400 终止本轮，避免重试或调用真实模型。
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { type: "invalid_request_error", message: "fixture captured" } }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing local fixture address");
      const legacyPath = join(directory, "config.json");
      const personalPath = join(directory, "provider_config.json");
      const env = {
        ZCODE_DATA_BASE_DIR: directory,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
      };
      const options = {
        standalone: {
          legacyCliUserConfigFilePath: legacyPath,
          credentialStore: createSharedZCodeCredentialStore({
            baseDir: join(directory, "credentials"),
            env,
          }),
        },
      };
      const input = {
        model: "evaluation/eval-model",
        provider: {
          evaluation: {
            kind,
            options: { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${address.port}/v1` },
            models: { "eval-model": legacy },
          },
        },
      };
      const original = JSON.stringify(input);
      try {
        await writeFile(legacyPath, original);
        const processRuntime = await startProcessProviderRegistryRuntime(env, options);
        const store = await createSqliteSessionStore({ dbPath: ":memory:" });
        try {
          const personal = await processRuntime.runtime.personalRepository.read();
          expect(personal.models.getExact("evaluation", "eval-model")?.toJSON()).toEqual({
            optionSpecs: { maxOutputTokens: { max: OUTPUT_BUDGET } },
          });
          const config = processRuntime.runtime.registryService.getModel(
            "evaluation",
            "eval-model",
          )?.config;
          expect(config?.optionSpecs.maxOutputTokens.max).toBe(OUTPUT_BUDGET);
          expect(config?.optionSpecs.maxOutputTokens.map).toContain(field);
          expect(await readFile(legacyPath, "utf8")).toBe(original);
          const app = await createZCodeApp({
            env,
            providerRegistry: processRuntime.runtime.registryService,
            configuredDefaultModelSelection: processRuntime.configuredDefaultModelSelection,
            modelAdapter: new AiSdkModelAdapter({ env: {}, network: { noProxy: "*" } }),
            sessionStore: store,
            skipUserConfig: true,
            runtimeConfig: { mcp: { enabled: false }, workingDirectory: directory },
          });
          try {
            await expect(app.runtime.executeTurn("Reply with ok.")).rejects.toThrow(
              "Turn execution failed",
            );
            expect(requests).toHaveLength(1);
            expect(requests[0]?.model).toBe("eval-model");
            expect(requests[0]?.[field]).toBe(OUTPUT_BUDGET);
          } finally {
            await app.close?.();
          }
        } finally {
          store.close();
          processRuntime.dispose();
        }
        const saved = await readFile(personalPath, "utf8");
        // 模拟评测修改旧文件：已有正式文件时不能覆盖迁移后的值。
        input.provider.evaluation.models["eval-model"] = { maxOutputTokens: 8_000 };
        await writeFile(legacyPath, JSON.stringify(input));
        const restart = await startProcessProviderRegistryRuntime(env, options);
        try {
          expect(
            restart.runtime.registryService.getModel("evaluation", "eval-model")?.config.optionSpecs
              .maxOutputTokens.max,
          ).toBe(OUTPUT_BUDGET);
          expect(await readFile(personalPath, "utf8")).toBe(saved);
        } finally {
          restart.dispose();
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
