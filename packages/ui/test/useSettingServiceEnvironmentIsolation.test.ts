// @vitest-environment jsdom
import { createElement, useEffect, type ReactNode } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

function createSettings(value: string): AppSettings {
  return { providerFamilyDomain: value } as AppSettings;
}

function createServices(settings: AppSettings) {
  return {
    settingService: {
      get: vi.fn(async () => settings),
      update: vi.fn(async () => {}),
    },
    botsService: {
      syncAppRuntimePreferences: vi.fn(async () => {}),
    },
    broadcastService: {
      send: vi.fn(async () => {}),
    },
    zcodeAgentService: {
      syncAppRuntimePreferences: vi.fn(async () => {}),
    },
  } as never;
}

function SettingsProbe({ onSnapshot }: { onSnapshot: (value: string | null) => void }) {
  const { settings } = useSettings();
  useEffect(() => {
    onSnapshot((settings?.providerFamilyDomain as string | undefined) ?? null);
  }, [onSnapshot, settings]);
  return null;
}

function EnvironmentProbes({
  remoteServices,
  localServices,
  onRemoteSnapshot,
  onLocalSnapshot,
}: {
  remoteServices: ReturnType<typeof createServices>;
  localServices: ReturnType<typeof createServices>;
  onRemoteSnapshot: (value: string | null) => void;
  onLocalSnapshot: (value: string | null) => void;
}): ReactNode {
  return createElement(
    ServiceProvider,
    { services: remoteServices },
    createElement(SettingsProbe, { onSnapshot: onRemoteSnapshot }),
    createElement(
      ServiceProvider,
      { services: localServices },
      createElement(SettingsProbe, { onSnapshot: onLocalSnapshot }),
    ),
  );
}

describe("useSettings Environment isolation", () => {
  it("keeps concurrent Local and Remote setting snapshots independent", async () => {
    const remoteServices = createServices(createSettings("remote"));
    const localServices = createServices(createSettings("local"));
    let remoteSnapshot: string | null = null;
    let localSnapshot: string | null = null;

    render(
      createElement(EnvironmentProbes, {
        remoteServices,
        localServices,
        onRemoteSnapshot: (value) => {
          remoteSnapshot = value;
        },
        onLocalSnapshot: (value) => {
          localSnapshot = value;
        },
      }),
    );

    await waitFor(() => {
      expect(remoteSnapshot).toBe("remote");
      expect(localSnapshot).toBe("local");
    });
    expect(remoteServices.settingService.get).toHaveBeenCalledOnce();
    expect(localServices.settingService.get).toHaveBeenCalledOnce();
  });
});
