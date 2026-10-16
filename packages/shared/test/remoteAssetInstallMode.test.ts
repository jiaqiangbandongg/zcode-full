import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  normalizeRemoteAssetInstallMode,
} from "../src/remoteAssetInstallMode.js";
import { remoteTargetSchema } from "../src/validation.js";

describe("remote asset install mode", () => {
  it("defaults missing SSH assetInstallMode to local download upload", () => {
    expect(normalizeRemoteAssetInstallMode()).toBe(
      DEFAULT_REMOTE_ASSET_INSTALL_MODE,
    );
  });

  it("accepts remote-download on SSH targets", () => {
    expect(
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        assetInstallMode: "remote-download",
      }),
    ).toMatchObject({ assetInstallMode: "remote-download" });
  });

  it("rejects invalid SSH assetInstallMode values", () => {
    expect(() =>
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        assetInstallMode: "auto-install-tools",
      }),
    ).toThrow();
  });
});
