import type { ICredentialService } from "@zcode/services";
import type { AppSettings } from "@zcode/shared";

export const WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY =
  "web-remote-control:external-relay:pass_hash";

export interface WebRemoteControlRelayStoredAuth {
  deviceSid: string;
  passHash: string;
}

export interface WebRemoteControlRelayAuthStorageProvider {
  load(): Promise<WebRemoteControlRelayStoredAuth | undefined>;
  save(auth: WebRemoteControlRelayStoredAuth): Promise<void>;
  clear(): Promise<void>;
  rotate(auth: WebRemoteControlRelayStoredAuth): Promise<void>;
}

interface WebRemoteControlRelayAuthStorageDependencies {
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  loadSettings(): Promise<AppSettings>;
  patchSettings(patch: Partial<AppSettings>): Promise<void>;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

function safeAuthLogFields(auth: Partial<WebRemoteControlRelayStoredAuth>) {
  const deviceSid = auth.deviceSid?.trim();
  return {
    hasDeviceSid: Boolean(deviceSid),
    deviceSidSuffix: deviceSid ? deviceSid.slice(-6) : undefined,
    hasPassHash: Boolean(auth.passHash?.trim()),
  };
}

export function createWebRemoteControlRelayAuthStorageProvider({
  credentialService,
  loadSettings,
  patchSettings,
  logger,
}: WebRemoteControlRelayAuthStorageDependencies): WebRemoteControlRelayAuthStorageProvider {
  const clear = async () => {
    await patchSettings({ webRemoteControlExternalRelayDevice: undefined });
    await credentialService.delete(WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY);
    logger?.info("[web-remote-control] external relay auth cleared", {
      hasDeviceSid: false,
      hasPassHash: false,
    });
  };

  return {
    async load(): Promise<WebRemoteControlRelayStoredAuth | undefined> {
      const settings = await loadSettings();
      const deviceSid = settings.webRemoteControlExternalRelayDevice?.deviceSid.trim();
      const passHash = (
        await credentialService.load(WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY)
      )?.trim();

      if (!deviceSid && !passHash) {
        return undefined;
      }

      if (!deviceSid || !passHash) {
        logger?.warn("[web-remote-control] external relay auth partial state cleared", {
          hasDeviceSid: Boolean(deviceSid),
          hasPassHash: Boolean(passHash),
        });
        await clear();
        return undefined;
      }

      logger?.info("[web-remote-control] external relay auth loaded", {
        ...safeAuthLogFields({ deviceSid, passHash }),
      });
      return { deviceSid, passHash };
    },

    async save(auth: WebRemoteControlRelayStoredAuth): Promise<void> {
      await patchSettings({
        webRemoteControlExternalRelayDevice: { deviceSid: auth.deviceSid },
      });
      await credentialService.save(
        WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY,
        auth.passHash,
      );
      logger?.info("[web-remote-control] external relay auth saved", {
        ...safeAuthLogFields(auth),
      });
    },

    clear,

    async rotate(auth: WebRemoteControlRelayStoredAuth): Promise<void> {
      await clear();
      await this.save(auth);
      logger?.info("[web-remote-control] external relay auth rotated", {
        ...safeAuthLogFields(auth),
      });
    },
  };
}
