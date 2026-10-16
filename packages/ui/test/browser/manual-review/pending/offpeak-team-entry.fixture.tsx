import { useState } from "react";
import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { connectProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import { OffPeakNewTaskEntry } from "@/v4/OffPeakNewTaskEntry.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";

const query = new URLSearchParams(location.search);
const family = query.get("family") ?? "bigmodel";
const providerId = `account:${family}-team-coding-plan`;
const view = {
  revision: 1,
  providerTemplates: [],
  providers: [
    {
      providerId,
      enabled: true,
      executable: true,
      models: [],
      issues: [],
      effectiveConfig: {
        access: {
          type: "zhipu-account",
          accountType: family,
          mode: "team-coding-plan",
          entitled: !query.has("noPlan"),
        },
      },
    },
  ],
} as unknown as ProviderSettingsView;
const services = {
  providerSettingsService: {
    async getView() {
      return view;
    },
    onDidChange() {
      return { dispose() {} };
    },
  },
  settingService: {
    async get() {
      return { providerFamilyDomain: family };
    },
  },
  clientScenesService: {
    async list() {
      return { code: 0, data: [] };
    },
  },
  codingPlanSubscriptionService: {
    async getOffPeakClientConfig() {
      return {
        enabled: !query.has("grayOff"),
        ...(query.has("inactive") ? { codingPlanActive: false } : {}),
      };
    },
  },
  offPeakTaskService: {
    async list() {
      return [];
    },
    async getCodingPlanSupport() {
      return { supported: true, providerId };
    },
    async getTakeNumberAvailability() {
      return { canTakeNumber: true };
    },
  },
} as unknown as IServiceAccessor;
// 不让未渲染的 Team 场景抢走另一个 fixture 的 Registry 订阅。
if (new URLSearchParams(location.search).has("teamEntry")) {
  void connectProviderSettingsSnapshot(services.providerSettingsService).ready;
}

// 只替换外部服务；实际首页组件、模板草稿、套餐分类和灰度门控一起验收。
export function OffPeakTeamEntryFixture() {
  const [opened, setOpened] = useState(0);
  const state = useOffPeakTaskStore();
  return (
    <ServiceProvider services={services}>
      <PlatformProvider platform={{} as IPlatformService}>
        <button data-testid="dismiss-entry" onClick={() => state.dismissNewTaskBanner()}>
          关闭入口
        </button>
        <OffPeakNewTaskEntry onOpenAutomations={() => setOpened((n) => n + 1)} />
        <output data-testid="team-opened">{opened}</output>
        <output data-testid="team-loaded">
          {String(state.grayConfig !== null && !state.loading)}
        </output>
        <output data-testid="team-draft">{JSON.stringify(state.pendingCreateDraft)}</output>
      </PlatformProvider>
    </ServiceProvider>
  );
}
