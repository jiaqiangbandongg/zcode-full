import { useState } from "react";
import { createRoot } from "react-dom/client";
import { parseZCodeBuiltinModelConfigRules } from "@zcode/provider";
import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProviderTemplatePicker } from "@/settings/model-provider-section/ProviderTemplatePicker.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import {
  BooleanModelOption,
  JsonSlotEditor,
} from "@/settings/model-provider-section/ProviderModelMetadataFields.js";
import { ProviderModelInputModalityOptions } from "@/settings/model-provider-section/ProviderModelModalityOptions.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import {
  getProviderFormApiKeyManagementUrl,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import release from "../../../../../../config/provider/zcode-builtin.json";
import { ProviderModelEditorFixture } from "./provider-model-editor.fixture.js";
import { OffPeakEligibilityFixture } from "./offpeak-eligibility.fixture.js";
import { OffPeakTeamEntryFixture } from "./offpeak-team-entry.fixture.js";
import "@/styles.css";
import { Checkbox } from "@/components/ui/checkbox.js";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
const templates = release.config.providerConfigRules
  .templateRules as ProviderSettingsView["providerTemplates"];
function createProvider(templateId: string): ProviderSettingsFormProvider {
  const template = templates.find((t) => t.templateId === templateId)!;
  const config: ProviderSettingsFormProvider["config"] = {
    ...template.config,
    group: "standard-personal" as const,
    access: { ...template.config.access, apiKey: "fixture-key" },
  };
  const startPlan = params.get("access")?.startsWith("start-");
  if (params.get("access") === "account" || params.get("access") === "team" || startPlan) {
    config.access = {
      type: "zhipu-account",
      accountType: params.get("access") === "start-zai" ? "zai" : "bigmodel",
      mode: startPlan
        ? "start-plan"
        : params.get("access") === "team"
          ? "team-coding-plan"
          : "individual-coding-plan",
      entitled: true,
    };
  }
  return {
    providerId: "fixture",
    providerName: "Fixture Provider",
    templateId,
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: {},
    config,
    models: [...config.builtinModelIds!, "custom-fixture"].map((modelId) => ({
      kind: "candidate",
      modelId,
      builtin: modelId !== "custom-fixture",
      config: rules
        .resolve({
          providerId: "fixture",
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        })
        .toJSON(),
      personalConfig: {},
      hasPersonalConfig: modelId === "custom-fixture",
      executable: true,
      selectable: true,
    })),
  };
}
function Fixture() {
  const [provider, setProvider] = useState(() => createProvider("bigmodel-api"));
  const [picker, setPicker] = useState(!params.has("access"));
  const [opened, setOpened] = useState("");
  const [order, setOrder] = useState(["fixture", "second"]);
  const [selected, setSelected] = useState(false);
  const request = async (action: string, payload: unknown) => {
    const response = await fetch("/mutation", {
      method: "POST",
      body: JSON.stringify({ action, payload }),
    });
    if (!response.ok) throw new Error("fixture rejected");
  };
  return (
    <main className="relative min-h-screen bg-background p-4 text-foreground">
      {params.has("selectionError") ? (
        <section data-testid="subagent-error" className="pt-32 pb-8">
          <ToolLayout
            toolId="selection-error"
            icon={null}
            kindLabel="Agent"
            primaryText="general-purpose"
            showFailureStatus
            statusLabel={params.get("locale") === "zh-CN" ? "执行失败" : "Failed"}
            statusTooltip={getToolCallErrorText({
              status: "failed",
              error:
                "Cannot start subagent: No reasoning level selected / 未选择思考档位 [reason=reasoning-level-missing; selection=account:bigmodel-team-coding-plan/GLM-5.3]",
            })}
          />
        </section>
      ) : null}
      {params.has("vision") ? (
        <ModelConfigSelect
          modelGroups={buildRegistryModelSelectGroups("glm", {
            revision: 1,
            providers: [provider],
          })}
          normalizedValue=""
          triggerLabel="Pick model"
          showManageModelsAction={false}
          lockReasonMessage=""
          isItemLocked={() => false}
          onValueChange={() => undefined}
          showProviderLevel={false}
        />
      ) : null}
      {params.has("tiles") ? (
        <section data-testid="model-tiles" className="mb-4 flex flex-wrap gap-4">
          <div hidden aria-hidden="true">
            <Checkbox checked disabled data-testid="system-checkbox-on" />
            <Checkbox checked={false} disabled data-testid="system-checkbox-off" />
          </div>
          <ProviderModelInputModalityOptions
            value={{
              supportsText: true,
              supportsImage: selected,
              supportsVideo: false,
              supportsPdf: false,
            }}
            onChange={(next) => setSelected(next.supportsImage)}
          />
          <BooleanModelOption
            label="Capability"
            selected={selected}
            onToggle={() => setSelected(!selected)}
          />
          <BooleanModelOption
            label="System messages"
            selected={selected}
            overridden
            onToggle={() => setSelected(!selected)}
          />
          <JsonSlotEditor label="Mapping" value="{}" onChange={() => undefined} />
        </section>
      ) : null}
      <div className="flex gap-4">
        <div className="w-14 shrink-0 overflow-hidden md:w-56" data-testid="sidebar">
          <ModelProviderSectionNavigation
            navigationGroups={[
              {
                id: "custom",
                title: "Providers",
                items: order.map((id) => ({
                  key: id,
                  type: "custom",
                  label: id,
                  provider: { ...provider, providerId: id },
                  statusActive: true,
                })),
              },
            ]}
            selectedNodeKey="fixture"
            presetLoading={false}
            customLoading={false}
            onSelectNavItem={() => setPicker(false)}
            onReorderProviderIds={async (ids) => {
              await request("reorder", ids);
              setOrder(ids);
            }}
          />
        </div>
        <section className="relative min-w-0 flex-1 pb-32" data-testid="detail">
          <ProviderDetailFeedbackBoundary>
            {picker ? (
              <ProviderTemplatePicker
                templates={templates}
                creating={false}
                onBack={() => setPicker(false)}
                onCreateCustom={async () => {
                  setPicker(false);
                }}
                onCreateFromTemplate={async (id) => {
                  await request("create", id);
                  setProvider(createProvider(id));
                  setPicker(false);
                }}
              />
            ) : (
              <InlineEditableProviderCard
                provider={provider}
                presetApiKeyUrl={getProviderFormApiKeyManagementUrl(provider)}
                onOpenPresetApiKey={() =>
                  setOpened(getProviderFormApiKeyManagementUrl(provider) ?? "")
                }
                onSave={async (next) => {
                  await request("save", next);
                  setProvider((p) => ({
                    ...p,
                    enabled: next.enabledUpdate ?? p.enabled,
                    executable: next.enabledUpdate ?? p.executable,
                    providerName:
                      next.providerNameUpdate === undefined
                        ? p.providerName
                        : next.providerNameUpdate,
                    config: next.config,
                    personalConfig: next.personalConfig,
                  }));
                }}
                onAddPersonalModel={async (_id, model) => {
                  await request("add", model);
                }}
                onDeletePersonalModel={async (_id, modelId) => {
                  await request("delete", modelId);
                  setProvider((p) => ({
                    ...p,
                    models: p.models.filter((m) => m.modelId !== modelId),
                  }));
                }}
                onTestModel={async () => {
                  await request("test", {});
                  return { success: true };
                }}
              />
            )}
          </ProviderDetailFeedbackBoundary>
        </section>
      </div>
      <output data-testid="opened">{opened}</output>
      <output data-testid="order">{order.join(",")}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider
    services={
      {
        providerSettingsService: {
          resolveModelConfig: async (input: { modelId: string }) => {
            const response = await fetch(`/resolve?id=${encodeURIComponent(input.modelId)}`);
            if (!response.ok) throw new Error("recommendation failed");
            return response.json();
          },
        },
      } as unknown as IServiceAccessor
    }
  >
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        {params.has("teamEntry") ? (
          <OffPeakTeamEntryFixture />
        ) : params.has("offpeak") ? (
          <OffPeakEligibilityFixture />
        ) : params.has("editor") ? (
          <ProviderModelEditorFixture />
        ) : (
          <Fixture />
        )}
      </ZCodeIntlProvider>
    </TooltipProvider>
  </ServiceProvider>,
);
