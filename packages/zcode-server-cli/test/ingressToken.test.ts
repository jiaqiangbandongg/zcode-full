import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIngressToken } from "../src/server-core/ingressToken.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

describe("Server ingress token", () => {
  it("rotates a random 0600 token inside the Server run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-ingress-token-"));
    const layout = resolveServerLayout(join(root, "server"));
    await mkdir(layout.runDir, { recursive: true });

    const first = await createIngressToken(layout);
    const second = await createIngressToken(layout);

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(await readFile(layout.ingressTokenFile, "utf8")).toBe(second);
    if (process.platform !== "win32") {
      expect((await stat(layout.ingressTokenFile)).mode & 0o777).toBe(0o600);
    }
  });
});
