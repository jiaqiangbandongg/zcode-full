import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountProviderService,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
} from "@zcode/provider";
import { BUILTIN_MODEL_PROVIDER_IDS as ids } from "@zcode/shared";
import { expect, it } from "vitest";
import { NodeProviderRegistryRuntime } from "../src/index.js";
import { createNodeModelSelectionFacade } from "../src/model-selection-facade.js";

it("Host/Worker 共用 facade：Start 与付费并存，Start 不映射或迁移，付费仍按当前连接解析", async () => {
  const root = await mkdtemp(join(tmpdir(), "start154-selection-"));
  let available = true;
  let account!: AccountProviderService;
  const runtime = new NodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(root, "personal.json"),
    personalPollingIntervalMs: false,
    createAccountSource(configSource) {
      account = new AccountProviderService({
        configSource,
        resolve: async () => ({
          providers: new ProviderConfigMap(
            [ids.bigmodelStartPlan, ids.bigmodelTeamCodingPlan].map((id) => [
              id,
              new ProviderConfig({
                access: new ZhipuAccountAccessConfig({
                  entitled: id !== ids.bigmodelStartPlan || available,
                }),
                builtinModelIds: ["GLM-5.2"],
              }),
            ]),
          ),
          states: Object.fromEntries(
            [ids.bigmodelStartPlan, ids.bigmodelTeamCodingPlan].map((id) => [
              id,
              {
                current: true,
                availability:
                  id === ids.bigmodelStartPlan && !available ? "unavailable" : "available",
                entitled: id !== ids.bigmodelStartPlan || available,
              },
            ]),
          ),
        }),
      });
      return account;
    },
  });
  try {
    await runtime.start();
    const facade = createNodeModelSelectionFacade(runtime.registryService);
    const start = {
      providerId: ids.bigmodelStartPlan,
      modelId: "GLM-5.2",
      options: {
        reasoningLevel: facade
          .getView()
          .providers.find((p) => p.providerId === ids.bigmodelStartPlan)!
          .models.find((m) => m.modelId === "GLM-5.2")!.config.optionSpecs.reasoningLevel
          .values[0]!,
      },
    };
    const first = facade.getView(undefined, undefined, { selection: start });
    expect(first.providers.map((p) => p.providerId)).toEqual(
      expect.arrayContaining([ids.bigmodelStartPlan, ids.bigmodelTeamCodingPlan]),
    );
    expect(first.effectiveSelection).toEqual(start);
    expect({
      result: facade.getView(undefined, undefined, {
        selection: { ...start, providerId: ids.bigmodelIndividualCodingPlan },
      }),
      states: runtime.registryService.getSnapshot()?.account.states,
    }).toMatchObject({
      result: { effectiveSelection: { providerId: ids.bigmodelTeamCodingPlan } },
    });
    expect(
      facade.getView(undefined, undefined, {
        selection: { ...start, providerId: ids.zaiStartPlan },
      }).effectiveSelection,
    ).toBeNull();
    available = false;
    await account.refresh("start-expired");
    await runtime.registryService.refresh("start-expired");
    expect(
      facade.getView(undefined, undefined, { selection: start }).effectiveSelection,
    ).toBeNull();
    expect(start.providerId).toBe(ids.bigmodelStartPlan);
  } finally {
    runtime.dispose();
    account?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
