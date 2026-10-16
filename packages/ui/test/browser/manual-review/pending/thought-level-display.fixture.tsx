import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService, ZCodeConfigOption } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { getNextThoughtLevelValue } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const services = { settingService: { get: async () => ({}) } } as unknown as IServiceAccessor;
const platform = {} as IPlatformService;
const values = [
  "nothink",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "extra-high",
  "extra_high",
  "default",
];
const options = values.map((value) => ({
  value,
  name: value === "default" ? "Provider default" : value,
}));
const noop = () => {};

function Fixture() {
  const { intl } = useZCodeIntl();
  const [value, setValue] = useState("minimal");
  const [committed, setCommitted] = useState("");
  const selectRef = useRef<HTMLSpanElement>(null);
  const cycleRef = useRef<HTMLSpanElement>(null);
  const option: ZCodeConfigOption = {
    id: "thought_level",
    category: "thought_level",
    type: "select",
    currentValue: value,
    options,
  };
  const select = (next: string) => {
    setValue(next);
    setCommitted(next);
  };
  useToolbarShortcutBindings({
    hasAnyOption: true,
    toolbarDisabled: false,
    modelMenuDisabled: true,
    thoughtOption: option,
    onOpenModelMenu: noop,
    onCycleSessionMode: noop,
    onCycleThoughtLevel: () => {
      const next = getNextThoughtLevelValue(option);
      if (next !== null) select(next);
    },
  });
  return (
    <main className="min-h-screen bg-background p-4 text-ui-base text-foreground space-y-4">
      <div className="@container/composer rounded-xl border border-border p-3 space-y-3">
        <p>Composer</p>
        <div data-testid="select" ref={selectRef}>
          <ThoughtLevelCycleControl
            intl={intl}
            option={option}
            triggerRef={selectRef}
            onValueChange={select}
            indicatorClassName="hidden @xl/composer:block"
            restoreFocusSelector={null}
          />
        </div>
        <div data-testid="cycle" ref={cycleRef}>
          <ThoughtLevelCycleControl
            intl={intl}
            option={option}
            triggerRef={cycleRef}
            onValueChange={select}
            interactionMode="cycle"
            labelVisibilityClassName="inline-flex"
            restoreFocusSelector={null}
          />
        </div>
      </div>
      <div data-testid="subagent" className="rounded-xl border border-border p-3 space-y-3">
        <p>Subagent</p>
        <SubagentReasoningField
          disabled={false}
          intl={intl}
          state={{ kind: "supported", option }}
          labelVisibilityClassName="inline-flex"
          onValueCommit={select}
        />
      </div>
      <output data-testid="value">{value}</output>
      <output data-testid="committed">{committed}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </ZCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
