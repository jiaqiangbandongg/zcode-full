import { describe, expect, it } from "vitest";
import {
  createFsFaultInjector,
  createFsFaultInjectorFromEnv,
  parseFsFaultRulesFromEnvValue,
} from "../src/fs/fsFaultInjection.js";

describe("fsFaultInjection", () => {
  it("matches by operation and normalized path, then throws a Node-style errno error", () => {
    const injector = createFsFaultInjector([
      {
        code: "ENOSPC",
        id: "D01-session-history-enospc",
        operations: ["writeFile"],
        pathIncludes: "\\.zcode\\",
      },
    ]);

    expect(() =>
      injector.maybeThrow({
        operation: "rename",
        path: "/tmp/demo/.zcode/session.json",
      }),
    ).not.toThrow();

    expect(() =>
      injector.maybeThrow({
        operation: "writeFile",
        path: "/tmp/demo/.zcode/session.json",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ENOSPC",
        path: "/tmp/demo/.zcode/session.json",
        syscall: "writeFile",
        zcodeFsFaultId: "D01-session-history-enospc",
      }),
    );

    expect(injector.getHits()).toMatchObject([
      {
        code: "ENOSPC",
        id: "D01-session-history-enospc",
        matchIndex: 1,
        operation: "writeFile",
        path: "/tmp/demo/.zcode/session.json",
      },
    ]);
  });

  it("defaults to one match so one injected write does not poison unrelated later writes", () => {
    const injector = createFsFaultInjector([
      {
        code: "EACCES",
        id: "D03-provider-settings-eacces",
        operations: ["writeFile"],
        pathEndsWith: "/provider_config.json",
      },
    ]);

    expect(() =>
      injector.maybeThrow({
        operation: "writeFile",
        path: "/tmp/home/.zcode/v2/provider_config.json",
      }),
    ).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(() =>
      injector.maybeThrow({
        operation: "writeFile",
        path: "/tmp/home/.zcode/v2/provider_config.json",
      }),
    ).not.toThrow();
    expect(injector.getHits()).toHaveLength(1);
  });

  it("supports unlimited matches when maxMatches is zero", () => {
    const injector = createFsFaultInjector([
      {
        code: "ENOSPC",
        id: "D02-workspace-write-enospc",
        maxMatches: 0,
        operations: ["rename"],
        pathRegex: "/workspace/.+\\.tmp$",
      },
    ]);

    for (let index = 0; index < 3; index += 1) {
      expect(() =>
        injector.maybeThrow({
          operation: "rename",
          path: `/tmp/workspace/file-${index}.tmp`,
        }),
      ).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    }

    expect(injector.getHits().map((hit) => hit.matchIndex)).toEqual([1, 2, 3]);
  });

  it("keeps env-based injection disabled outside test mode unless explicitly allowed", () => {
    const rawRules = JSON.stringify([
      {
        code: "ENOSPC",
        id: "D01-session-history-enospc",
      },
    ]);

    const productionInjector = createFsFaultInjectorFromEnv({
      NODE_ENV: "production",
      ZCODE_E2E_FS_FAULTS: rawRules,
      ZCODE_ENV: "production",
    });
    expect(productionInjector.isEnabled()).toBe(false);

    const testInjector = createFsFaultInjectorFromEnv({
      NODE_ENV: "production",
      ZCODE_E2E_FS_FAULTS: rawRules,
      ZCODE_ENV: "test",
    });
    expect(testInjector.isEnabled()).toBe(true);

    const explicitlyAllowedInjector = createFsFaultInjectorFromEnv({
      NODE_ENV: "production",
      ZCODE_E2E_FS_FAULTS: rawRules,
      ZCODE_E2E_FS_FAULTS_ALLOW: "1",
      ZCODE_ENV: "production",
    });
    expect(explicitlyAllowedInjector.isEnabled()).toBe(true);
  });

  it("rejects malformed env rules early as infra errors", () => {
    expect(() => parseFsFaultRulesFromEnvValue("{")).toThrow(/Invalid ZCODE_E2E_FS_FAULTS/);
    expect(() => parseFsFaultRulesFromEnvValue("{}")).toThrow(/expected a JSON array/);
    expect(() =>
      createFsFaultInjector([
        {
          code: "ENOSPC",
          id: "bad-operation",
          operations: ["not-a-real-operation" as "writeFile"],
        },
      ]),
    ).toThrow(/unsupported operation/);
  });
});
