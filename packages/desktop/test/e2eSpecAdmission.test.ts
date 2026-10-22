import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveE2EScheduledSpecFiles } from "#e2e/helpers/e2e-spec-resolution";

import {
  hasRequiredSshE2EEnvironment,
  MANUAL_REVIEW_SPEC_GLOB,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "../scripts/e2e-formal-spec-selection.mjs";

describe("desktop E2E environment-gated formal spec admission", () => {
  it("excludes every manual-review domain from the default recursive glob", () => {
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/**/*.test.ts"],
      exclude: [MANUAL_REVIEW_SPEC_GLOB],
    });
    expect(scheduled).toContain("test/e2e/smoke.test.ts");
    expect(scheduled.some((spec) => spec.includes("/manual-review/"))).toBe(false);
  });

  it.each(["bots", "settings", "feedback"])(
    "keeps explicit %s candidates discoverable",
    (domain) => {
      const scheduled = resolveE2EScheduledSpecFiles({
        baseDir: resolve("packages/desktop"),
        specs: [`./test/e2e/${domain}/manual-review/**/*.test.ts`],
        exclude: [],
      });
      expect(scheduled.length).toBeGreaterThan(0);
      expect(scheduled.every((spec) => spec.includes(`/${domain}/manual-review/`))).toBe(true);
    },
  );

  it("excludes real SSH specs from default runs without complete credentials", () => {
    expect(hasRequiredSshE2EEnvironment({})).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts",
    );
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
