import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("独立 Server 装配在提供服务前迁移稳定 owner，并保留 canonical workspace identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-server-host-"));
  try {
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", resolve("packages/services/test/helpers/serverHostServicesFixture.ts")],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home },
        timeout: 30_000,
      },
    );
    expect(result.stdout).toContain("SERVER_HOST_VERIFIED");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 35_000);
