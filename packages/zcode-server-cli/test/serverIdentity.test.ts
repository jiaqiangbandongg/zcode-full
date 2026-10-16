import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { resolveCoreServerId } from "../src/server-core/serverIdentity.js";
import { validateServerInstallOwnership } from "../src/runtime/installationOwnership.js";

describe("Server Core identity", () => {
  it("uses the persisted installation id from the ownership marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-server-identity-"));
    const layout = resolveServerLayout(join(root, "server"));
    await new ReleaseManager(layout).ensure();
    const ownership = await validateServerInstallOwnership(layout);

    await expect(resolveCoreServerId(layout.serverRoot)).resolves.toBe(ownership.installationId);
  });

  it("leaves direct HTTP factory callers without a server root compatible", async () => {
    await expect(resolveCoreServerId()).resolves.toBeUndefined();
  });
});
