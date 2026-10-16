import { PassThrough } from "node:stream";
import type { IDisposable, Event } from "@zcode/rpc";
import type {
  IRemoteBackend,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { checkRemoteAssetComponentIdentity } from "@zcode/server/remote/remoteAssetLiveIdentity.js";
import { describe, expect, it } from "vitest";

class IdentityBackend implements IRemoteBackend {
  constructor(private readonly meta: Record<string, unknown>) {}

  dispose(): void {}

  async detect() {
    return { platform: "linux", arch: "x64" } as const;
  }

  async upload(): Promise<void> {}

  async exec(): Promise<StdioStream> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const onClose: Event<number> = (listener): IDisposable => {
      queueMicrotask(() => listener(0));
      return { dispose() {} };
    };
    return { stdin, stdout, stderr, onClose };
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async readFile(): Promise<string> {
    return JSON.stringify(this.meta);
  }
}

describe("GLM remote asset live identity", () => {
  it("ignores the semantic version when the artifact SHA is unchanged", async () => {
    const sha256 = "a".repeat(64);
    const backend = new IdentityBackend({
      id: "glm",
      version: "v0.13.2",
      sha256,
      platformArch: "linux-x64",
    });

    await expect(
      checkRemoteAssetComponentIdentity(backend, {
        componentId: "glm",
        platformArch: "linux-x64",
        expectedIdentity: { sha256 },
      }),
    ).resolves.toEqual({ shouldDeploy: false });
  });

  it("does not require a version field when the artifact SHA is unchanged", async () => {
    const sha256 = "a".repeat(64);
    const backend = new IdentityBackend({
      id: "glm",
      sha256,
      platformArch: "linux-x64",
    });

    await expect(
      checkRemoteAssetComponentIdentity(backend, {
        componentId: "glm",
        platformArch: "linux-x64",
        expectedIdentity: { sha256 },
      }),
    ).resolves.toEqual({ shouldDeploy: false });
  });

  it("deploys when the artifact SHA changes even if the version is unchanged", async () => {
    const backend = new IdentityBackend({
      id: "glm",
      version: "v0.13.3",
      sha256: "a".repeat(64),
      platformArch: "linux-x64",
    });

    await expect(
      checkRemoteAssetComponentIdentity(backend, {
        componentId: "glm",
        platformArch: "linux-x64",
        expectedIdentity: { sha256: "b".repeat(64) },
      }),
    ).resolves.toEqual({
      shouldDeploy: true,
      reason: `remote SHA mismatch remote=${"a".repeat(64)} expected=${"b".repeat(64)}`,
    });
  });
});
