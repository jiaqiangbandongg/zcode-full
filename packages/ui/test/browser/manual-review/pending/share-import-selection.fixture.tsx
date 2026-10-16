import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, IModelSelectionService, ModelSelectionView } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { resolveEffectiveModelSelection, type ProviderRegistryView } from "@zcode/provider";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { captureComposerRecentSubmission } from "@/lib/composerRecent.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { persistV4ComposerDraft, readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { seedImportedSessionDraft } from "@/v4/composer/newTaskDraft.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const source = params.get("source") ?? "root";
const workspacePath = "/share-selection-fixture";
const selection = {
  providerId: "recipient",
  modelId: "recipient-model",
  options: { reasoningLevel: "high" },
};
const view = {
  revision: 1,
  preferredSelection: selection,
  providers: [
    {
      providerId: "recipient",
      providerName: "Recipient",
      config: { api: { type: "anthropic-messages", baseUrl: "https://fixture.invalid" } },
      models: [
        {
          modelId: "recipient-model",
          config: {
            enabled: true,
            optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } },
          },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;
const modelSelectionService: IModelSelectionService = {
  getView: async (input) => ({
    ...view,
    ...resolveEffectiveModelSelection({
      selection: input?.selection ?? null,
      registry: view as unknown as ProviderRegistryView,
      classifyProvider: () => "ordinary",
    }),
  }),
  onDidChange: () => ({ dispose() {} }),
};
const services = {
  zcodeSessionService: {},
  settingService: { get: async () => ({}) },
} as unknown as IServiceAccessor;
const platform = {} as IPlatformService;
if (!sessionStorage.getItem("prepared")) {
  sessionStorage.setItem("prepared", "true");
  if (source === "recent")
    captureComposerRecentSubmission(workspacePath, { modelSelection: selection, mode: "yolo" })();
  if (source === "root" || source === "empty")
    persistV4ComposerDraft(workspacePath, undefined, "__draft__", {
      text: "ROOT MUST STAY",
      mode: "plan",
      ...(source === "root" ? { modelSelection: selection } : {}),
    });
}
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";

function Fixture() {
  const { intl } = useZCodeIntl();
  const [sessionId, setSessionId] = useState<string | null>("unrelated-history");
  const [ready, setReady] = useState(source !== "delayed");
  const [picker, setPicker] = useState<V4ComposerConfigPicker | null>(null);
  const [submitted, setSubmitted] = useState("");
  const thoughtRef = useRef<HTMLSpanElement>(null);
  const control = useDraftConfigControl({
    workspacePath,
    sessionId,
    sessionConfig: { mode: "build" },
    agentStartupAllowed: false,
    modelSelectionService: ready ? modelSelectionService : null,
  });
  const current = control.draftConfig.modelSelection;
  const config = createComposerSubmissionConfig(control.draftConfig, ready ? view : null);
  const open = (next: V4ComposerConfigPicker, value: boolean) => setPicker(value ? next : null);
  return (
    <main className="bg-background text-foreground min-h-screen p-4 space-y-4">
      <button
        onClick={() => {
          seedImportedSessionDraft({ workspacePath, sessionId: "imported", reused: false });
          setSessionId("imported");
        }}
      >
        Import
      </button>
      <button
        onClick={() => {
          seedImportedSessionDraft({ workspacePath, sessionId: "imported", reused: true });
          setSessionId("imported");
        }}
      >
        Reopen
      </button>
      <button onClick={() => setSessionId(null)}>Ordinary new task</button>
      <button onClick={() => setReady(true)}>Registry ready</button>
      <p data-testid="content">{sessionId === "imported" ? "IMPORTED CONTENT" : "other"}</p>
      <div className="flex flex-wrap gap-2">
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          draftConfig={control.draftConfig}
          disabled={false}
          activeConfigPicker={picker}
          onConfigPickerOpenChange={open}
          onSwitchMode={control.handleDraftSwitchMode}
        />
        <ModelConfigSelect
          modelGroups={buildRegistryModelSelectGroups("glm", view)}
          normalizedValue={
            current ? encodeCustomModelValue(current.providerId, current.modelId) : ""
          }
          triggerLabel={current?.modelId ?? "Pick model"}
          labelVisibilityClassName="inline-flex"
          showManageModelsAction={false}
          lockReasonMessage=""
          isItemLocked={() => false}
          onValueChange={(value) => {
            const parsed = decodeCustomModelValue(value);
            if (parsed?.modelName)
              control.handleDraftSelectModel(parsed.providerId, parsed.modelName);
          }}
        />
        <span ref={thoughtRef}>
          <ThoughtLevelCycleControl
            intl={intl}
            triggerRef={thoughtRef}
            labelVisibilityClassName="inline-flex"
            option={{
              id: "thought",
              name: "Reasoning",
              type: "select",
              category: "thought",
              currentValue: current?.options?.reasoningLevel ?? "",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            }}
            onValueChange={control.handleDraftSelectThought}
          />
        </span>
      </div>
      <textarea
        aria-label="Message"
        value={control.composerDraft.text}
        onChange={(event) => control.updateComposerContent({ text: event.target.value })}
      />
      <button
        disabled={!config}
        onClick={() => {
          const frozen = createComposerSubmissionConfig(control.draftConfig, view);
          setSubmitted(JSON.stringify(frozen));
        }}
      >
        Submit
      </button>
      <output data-testid="config">{JSON.stringify(control.draftConfig)}</output>
      <output data-testid="root-draft">
        {JSON.stringify(readV4ComposerDraft(workspacePath, undefined, "__draft__"))}
      </output>
      <output data-testid="submission">{submitted}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <TabStoreProvider>
        <ZCodeIntlProvider locale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
          <TooltipProvider>
            <Fixture />
          </TooltipProvider>
        </ZCodeIntlProvider>
      </TabStoreProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
