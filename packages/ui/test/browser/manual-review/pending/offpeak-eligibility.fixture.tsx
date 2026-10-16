import { useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type {
  IServiceAccessor,
  IProviderSettingsService,
  ProviderSettingsView,
} from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { connectProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import {
  useOffPeakTaskStore,
  isCurrentOffPeakCodingPlanSupported,
} from "@/store/offPeakTaskStore.js";
import { resolveOffPeakCreateBlockReason } from "@/settings/offPeakUiPresentation.js";

// 真实 Snapshot/Hook/Store/门禁；只替换 Host RPC，不取号、不修改账号或磁盘。
let revision = 1;
let supported = false;
let fail = false;
let listener: ((view: ProviderSettingsView) => void) | undefined;
const support = {
  supported: true,
  kind: "bigmodel-team",
  providerFamily: "bigmodel",
  providerId: "account:bigmodel-team-coding-plan",
  selectedConnectionKey: "team-plan:test",
};
const services = {
  providerSettingsService: {
    onDidChange(callback: typeof listener) {
      listener = callback;
      return {
        dispose() {
          listener = undefined;
        },
      };
    },
    async getView() {
      return { revision, providers: [], providerTemplates: [] };
    },
  },
  codingPlanSubscriptionService: {
    async getOffPeakClientConfig() {
      return { enabled: true };
    },
  },
  offPeakTaskService: {
    async list() {
      return [];
    },
    async getCodingPlanSupport() {
      await fetch("/eligibility-rpc", {
        method: "POST",
        body: JSON.stringify({ call: "support", supported }),
      });
      if (fail) throw new Error("controlled RPC failure");
      return supported ? support : { supported: false };
    },
    async getTakeNumberAvailability() {
      await fetch("/eligibility-rpc", {
        method: "POST",
        body: JSON.stringify({ call: "availability" }),
      });
      return { canTakeNumber: true };
    },
  },
} as unknown as IServiceAccessor;
// 同一入口静态导入多个 fixture；只有当前场景可以占有全局 Snapshot，避免互相覆盖连接。
if (new URLSearchParams(location.search).has("offpeak")) {
  void connectProviderSettingsSnapshot(services.providerSettingsService as IProviderSettingsService)
    .ready;
}
const settings = {
  providerFamilyDomain: "bigmodel",
  providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan" } },
} as AppSettings;

function Entry({ name }: { name: string }) {
  const read = useProviderSettingsView();
  useOffPeakEligibility(
    settings,
    read.state.status === "ready" ? read.state.view.revision : undefined,
  );
  const state = useOffPeakTaskStore();
  const reason = resolveOffPeakCreateBlockReason({
    grayEnabled: state.grayConfig?.enabled === true,
    noPlan: !isCurrentOffPeakCodingPlanSupported(state.codingPlanSupport, settings),
    availabilityStatus: state.takeNumberAvailabilityStatus,
    canTakeNumber: state.takeNumberAvailability?.canTakeNumber,
  });
  return (
    <section>
      <button data-testid={`create-${name}`} disabled={reason !== null}>
        创建
      </button>
      <output data-testid={`status-${name}`}>{state.takeNumberAvailabilityStatus}</output>
      <button
        data-testid={`refresh-${name}`}
        onClick={() => void state.refreshCodingPlanSupport(services.offPeakTaskService)}
      >
        刷新
      </button>
    </section>
  );
}

export function OffPeakEligibilityFixture() {
  const [second, setSecond] = useState(true);
  const publish = () => {
    revision += 1;
    listener?.({ revision, providers: [], providerTemplates: [] });
  };
  return (
    <ServiceProvider services={services}>
      <button
        data-testid="account-ready"
        onClick={() => {
          supported = true;
          fail = false;
          publish();
        }}
      >
        账号解析完成
      </button>
      <button
        data-testid="account-off"
        onClick={() => {
          supported = false;
          publish();
        }}
      >
        账号退出
      </button>
      <button
        data-testid="account-silent"
        onClick={() => {
          supported = true;
          fail = false;
        }}
      >
        后端恢复但不通知
      </button>
      <button
        data-testid="rpc-fail"
        onClick={() => {
          fail = true;
          publish();
        }}
      >
        请求失败
      </button>
      <button data-testid="second-entry" onClick={() => setSecond(!second)}>
        第二入口
      </button>
      <Entry name="automation" />
      {second && <Entry name="home" />}
    </ServiceProvider>
  );
}
