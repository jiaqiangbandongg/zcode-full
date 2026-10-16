import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  hasRequiredSshE2EEnvironment,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "../scripts/e2e-formal-spec-selection.mjs";

describe("desktop E2E environment-gated formal spec admission", () => {
  it("excludes real SSH specs from default runs without complete credentials", () => {
    expect(hasRequiredSshE2EEnvironment({})).toBe(false);
    expect(
      resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false }),
    ).toContain("./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts");
  });

  it("keeps explicit SSH runs fail-closed and admits configured default runs", () => {
    const env = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
    };
    expect(hasRequiredSshE2EEnvironment(env)).toBe(true);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toEqual([]);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: true })).toEqual([]);
  });

  it("uses the shared admission helper in the WDIO exclude list", () => {
    const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveEnvironmentGatedFormalSpecExcludes({");
    expect(source).toContain("hasRequiredSshE2EEnvironment(process.env)");
  });
});
