import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  type ModelSelection,
  type ProviderRegistryServiceSnapshot,
} from "@zcode/provider";
import { legacyReasoningLevelRenames as renames } from "./legacy-reasoning-level-renames.js";

const oldRulesCache = new WeakMap<ModelConfigRules, ModelConfigRules>();

/** 只为历史 Selection 恢复已知 Built-in 旧值域；不迁移 Personal 配置或在执行层放宽校验。 */
export function resolveLegacyReasoningLevel(
  snapshot: ProviderRegistryServiceSnapshot,
  selection: ModelSelection,
): string | undefined {
  const oldLevel = selection.options?.reasoningLevel;
  if (oldLevel !== "off" && oldLevel !== "nothink") return undefined;
  const personal = snapshot.config.personalModels.getExactRule(
    selection.providerId,
    selection.modelId,
  );
  if (
    personal &&
    (personal.type === "manual-provider-model" ||
      personal.config.optionSpecs?.reasoningLevel?.values !== undefined ||
      personal.config.optionSpecs?.reasoningLevel?.map !== undefined)
  )
    return undefined;
  const provider = snapshot.resolution.effectiveProviders.get(selection.providerId);
  if (!provider) return undefined;
  const builtin = snapshot.config.zcodeBuiltinModelRules;
  let oldRules = oldRulesCache.get(builtin);
  if (!oldRules) {
    oldRules = new ModelConfigRules(
      builtin.rules().map((rule) => {
        // matcher 简化会改变字符串身份：同时认旧缓存和新选择器，但恢复范围仍用历史 matcher。
        // 否则老选择会失效，或把新放宽的后缀误认成曾经支持 off/nothink 的型号。
        const rename =
          rule.type === "model"
            ? renames.find(
                (entry) =>
                  entry.modelMatch === rule.modelMatch ||
                  entry.simplifiedModelMatch === rule.modelMatch,
              )
            : undefined;
        const values = rule.config.optionSpecs?.reasoningLevel?.values;
        return rename && values?.includes("disabled")
          ? {
              ...rule,
              modelMatch: rename.modelMatch,
              config: rule.config.overlay(
                new ModelConfig({
                  optionSpecs: new ModelOptionSpecsConfig({
                    reasoningLevel: {
                      values: values.map((value) =>
                        value === "disabled" ? rename.oldLevel : value,
                      ),
                    },
                  }),
                }),
              ),
            }
          : rule;
      }),
    );
    oldRulesCache.set(builtin, oldRules);
  }
  // 用原规则引擎处理大小写、前后缀、API/站点与后续覆盖，不复制第二套匹配逻辑。
  const values = oldRules.resolve({
    providerId: selection.providerId,
    modelId: selection.modelId,
    templateId: snapshot.resolution.effectiveProviders.getRule(selection.providerId)?.templateId,
    apiType: provider.api?.type,
    baseUrl: provider.api?.baseUrl,
  }).optionSpecs?.reasoningLevel?.values;
  return values?.includes(oldLevel) ? "disabled" : undefined;
}
