# Internal-Only Feature Effective Env Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime env overrides for internal-only feature gates so development builds can simulate production internet conditions without changing global `ZCODE_ENV` behavior.

**Architecture:** Introduce a small shared runtime-override parser that computes the effective env/network only for internal-only feature gates. Reuse that parser from both the UI gate hook and the service-side ZAPI gate, while leaving all existing raw `ZCODE_ENV` consumers untouched.

**Tech Stack:** TypeScript, Vitest, shared/ui/services packages, pnpm, oxlint, tsc build mode

---

### Task 1: Add shared internal-only runtime override parser

**Files:**
- Create: `packages/shared/src/internalOnlyFeatureRuntimeEnv.ts`
- Create: `packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing shared tests**

```ts
import { describe, expect, it } from "vitest";
import {
  resolveInternalOnlyFeatureGateState,
  resolveInternalOnlyFeatureRuntimeOverrides,
} from "../src/internalOnlyFeatureRuntimeEnv.js";

describe("internalOnlyFeatureRuntimeEnv", () => {
  it("defaults to raw env with auto network when no runtime override is set", () => {
    expect(resolveInternalOnlyFeatureRuntimeOverrides({})).toEqual({
      effectiveEnv: undefined,
      networkEnv: "auto",
    });
    expect(
      resolveInternalOnlyFeatureGateState({
        rawEnv: "development",
        probedIsIntranet: false,
        env: {},
      }),
    ).toEqual({
      env: "development",
      isIntranet: false,
      shouldProbe: false,
    });
  });

  it("maps ZCODE_SIMULATE_PUBLIC_PROD to production internet", () => {
    expect(
      resolveInternalOnlyFeatureGateState({
        rawEnv: "development",
        probedIsIntranet: true,
        env: { ZCODE_SIMULATE_PUBLIC_PROD: "1" },
      }),
    ).toEqual({
      env: "production",
      isIntranet: false,
      shouldProbe: false,
    });
  });

  it("lets explicit overrides win over the shortcut flag", () => {
    expect(
      resolveInternalOnlyFeatureGateState({
        rawEnv: "development",
        probedIsIntranet: false,
        env: {
          ZCODE_SIMULATE_PUBLIC_PROD: "true",
          ZCODE_EFFECTIVE_ENV: "production",
          ZCODE_NETWORK_ENV: "intranet",
        },
      }),
    ).toEqual({
      env: "production",
      isIntranet: true,
      shouldProbe: false,
    });
  });

  it("keeps production auto-probe behavior when only effective env is production", () => {
    expect(
      resolveInternalOnlyFeatureGateState({
        rawEnv: "development",
        probedIsIntranet: true,
        env: {
          ZCODE_EFFECTIVE_ENV: "production",
        },
      }),
    ).toEqual({
      env: "production",
      isIntranet: true,
      shouldProbe: true,
    });
  });
});
```

- [ ] **Step 2: Run the shared test to verify it fails**

Run: `pnpm vitest run packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts`

Expected: FAIL with module-not-found or missing export errors for `internalOnlyFeatureRuntimeEnv`.

- [ ] **Step 3: Implement the runtime override parser**

```ts
import type { ZCodeEnv } from "./env.js";

export type InternalOnlyFeatureNetworkEnv = "auto" | "intranet" | "internet";

export interface InternalOnlyFeatureRuntimeOverrides {
  effectiveEnv?: ZCodeEnv;
  networkEnv: InternalOnlyFeatureNetworkEnv;
}

export interface InternalOnlyFeatureGateState {
  env: ZCodeEnv;
  isIntranet: boolean;
  shouldProbe: boolean;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function normalizeEffectiveEnv(value: string | undefined): ZCodeEnv | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "development" || normalized === "production"
    ? normalized
    : undefined;
}

function normalizeNetworkEnv(
  value: string | undefined,
): InternalOnlyFeatureNetworkEnv | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "auto" ||
    normalized === "intranet" ||
    normalized === "internet"
    ? normalized
    : undefined;
}

export function resolveInternalOnlyFeatureRuntimeOverrides(
  env: NodeJS.ProcessEnv = {},
): InternalOnlyFeatureRuntimeOverrides {
  const explicitEffectiveEnv = normalizeEffectiveEnv(env.ZCODE_EFFECTIVE_ENV);
  const explicitNetworkEnv = normalizeNetworkEnv(env.ZCODE_NETWORK_ENV);

  if (explicitEffectiveEnv || explicitNetworkEnv) {
    return {
      effectiveEnv: explicitEffectiveEnv,
      networkEnv: explicitNetworkEnv ?? "auto",
    };
  }

  if (isTruthyEnvFlag(env.ZCODE_SIMULATE_PUBLIC_PROD)) {
    return {
      effectiveEnv: "production",
      networkEnv: "internet",
    };
  }

  return {
    effectiveEnv: undefined,
    networkEnv: "auto",
  };
}

export function resolveInternalOnlyFeatureGateState(params: {
  rawEnv: ZCodeEnv;
  probedIsIntranet: boolean;
  env?: NodeJS.ProcessEnv;
}): InternalOnlyFeatureGateState {
  const overrides = resolveInternalOnlyFeatureRuntimeOverrides(params.env ?? {});
  const effectiveEnv = overrides.effectiveEnv ?? params.rawEnv;
  const effectiveIsIntranet =
    overrides.networkEnv === "intranet"
      ? true
      : overrides.networkEnv === "internet"
        ? false
        : params.probedIsIntranet;

  return {
    env: effectiveEnv,
    isIntranet: effectiveIsIntranet,
    shouldProbe: effectiveEnv === "production" && overrides.networkEnv === "auto",
  };
}
```

- [ ] **Step 4: Export the new shared helpers**

```ts
export * from "./internalOnlyFeatureRuntimeEnv.js";
```

- [ ] **Step 5: Run the shared test to verify it passes**

Run: `pnpm vitest run packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts`

Expected: PASS with 4 passing tests in `packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts`.

- [ ] **Step 6: Commit the shared parser**

```bash
git add packages/shared/src/internalOnlyFeatureRuntimeEnv.ts packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add internal feature env overrides"
```

### Task 2: Wire the UI internal-only gate to the shared parser

**Files:**
- Modify: `packages/ui/src/hooks/useInternalOnlyFeatureVisibility.ts`
- Modify: `packages/ui/test/remoteConnectionEntryVisibility.test.ts`

- [ ] **Step 1: Extend the UI-facing gate test with override cases**

```ts
import { describe, expect, it } from "vitest";
import { shouldShowRemoteConnectionEntry } from "../src/hooks/useRemoteConnectionEntryVisibility.js";

describe("shouldShowRemoteConnectionEntry", () => {
  it("development env always returns true", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "development",
        isIntranet: false,
      }),
    ).toBe(true);
  });

  it("production internet returns false", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "production",
        isIntranet: false,
      }),
    ).toBe(false);
  });

  it("production intranet returns true", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "production",
        isIntranet: true,
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the UI gate test to verify the baseline still passes before wiring**

Run: `pnpm vitest run packages/ui/test/remoteConnectionEntryVisibility.test.ts`

Expected: PASS. This protects the existing pure gate behavior before the hook integration changes.

- [ ] **Step 3: Update the hook to use effective gate state instead of raw env directly**

```ts
import {
  INTERNAL_ONLY_FEATURE_INTRANET_PROBE_REQUEST,
  resolveInternalOnlyFeatureGateState,
  ZCODE_ENV,
  shouldEnableInternalOnlyFeature,
} from "@zcode/shared";
import { useIntranetProbe } from "@/hooks/useSystemService.js";

export function useInternalOnlyFeatureVisibility(): boolean {
  const gateState = resolveInternalOnlyFeatureGateState({
    rawEnv: ZCODE_ENV,
    probedIsIntranet: false,
    env: typeof process !== "undefined" ? process.env : {},
  });

  const { isIntranet } = useIntranetProbe(
    gateState.shouldProbe ? INTERNAL_ONLY_FEATURE_INTRANET_PROBE_REQUEST : null,
    {
      enabled: gateState.shouldProbe,
      autoProbe: gateState.shouldProbe,
    },
  );

  const effectiveGateState = resolveInternalOnlyFeatureGateState({
    rawEnv: ZCODE_ENV,
    probedIsIntranet: gateState.shouldProbe ? isIntranet : gateState.isIntranet,
    env: typeof process !== "undefined" ? process.env : {},
  });

  return shouldEnableInternalOnlyFeature({
    env: effectiveGateState.env,
    isIntranet: effectiveGateState.isIntranet,
  });
}
```

- [ ] **Step 4: Run the UI tests to verify they still pass**

Run: `pnpm vitest run packages/ui/test/remoteConnectionEntryVisibility.test.ts packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts`

Expected: PASS with all tests green.

- [ ] **Step 5: Commit the UI hook wiring**

```bash
git add packages/ui/src/hooks/useInternalOnlyFeatureVisibility.ts packages/ui/test/remoteConnectionEntryVisibility.test.ts packages/shared/src/internalOnlyFeatureRuntimeEnv.ts packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts packages/shared/src/index.ts
git commit -m "feat(ui): honor internal feature env overrides"
```

### Task 3: Wire the service-side ZAPI gate to the shared parser

**Files:**
- Modify: `packages/services/src/node.ts`
- Modify: `packages/services/test/modelProviderService.test.ts`

- [ ] **Step 1: Add service coverage for the new effective gate combinations**

```ts
it("非内网场景会隐藏 ZAPI 且跳过 ZAPI 模型拉取", async () => {
  const home = makeTempHome();
  const fetchImpl = createZapiPresetFetchMock();
  const service = await createServiceInHome(home, {
    fetchImpl,
    credentialLoad: async () => null,
    isZapiAllowed: () => false,
  });

  const list = await service.getAll();
  expect(list.some((item) => item.id === BUILTIN_MODEL_PROVIDER_IDS.zapi)).toBe(false);
  expect(fetchImpl.mock.calls.map(([input]) => String(input)).some((url) => url.includes("/v1/models"))).toBe(false);
});
```

Add a focused integration helper test around the service-side gate if needed:

```ts
import { resolveInternalOnlyFeatureGateState } from "@zcode/shared";

it("simulate public prod maps to production internet for service-side gate", () => {
  expect(
    resolveInternalOnlyFeatureGateState({
      rawEnv: "development",
      probedIsIntranet: true,
      env: { ZCODE_SIMULATE_PUBLIC_PROD: "1" },
    }),
  ).toMatchObject({
    env: "production",
    isIntranet: false,
    shouldProbe: false,
  });
});
```

- [ ] **Step 2: Run the targeted services tests to verify the new assertion fails first**

Run: `pnpm vitest run packages/services/test/modelProviderService.test.ts packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts`

Expected: FAIL if the new service-side expectation depends on override-aware gate wiring that does not exist yet.

- [ ] **Step 3: Update `createLocalServices()` to compute the effective internal-only gate**

```ts
import {
  INTERNAL_ONLY_FEATURE_INTRANET_PROBE_REQUEST,
  resolveInternalOnlyFeatureGateState,
  shouldEnableInternalOnlyFeature,
  ZCODE_ENV,
} from "@zcode/shared";

const isZapiAllowed = async (): Promise<boolean> => {
  if (internalOnlyFeatureVisibilityPromise) {
    return internalOnlyFeatureVisibilityPromise;
  }

  internalOnlyFeatureVisibilityPromise = (async () => {
    const initialGateState = resolveInternalOnlyFeatureGateState({
      rawEnv: ZCODE_ENV,
      probedIsIntranet: false,
      env: process.env,
    });

    if (!initialGateState.shouldProbe) {
      return shouldEnableInternalOnlyFeature({
        env: initialGateState.env,
        isIntranet: initialGateState.isIntranet,
      });
    }

    try {
      const probeResult = await systemService.probeIntranet(
        INTERNAL_ONLY_FEATURE_INTRANET_PROBE_REQUEST,
      );
      const finalGateState = resolveInternalOnlyFeatureGateState({
        rawEnv: ZCODE_ENV,
        probedIsIntranet: probeResult.isIntranet,
        env: process.env,
      });
      return shouldEnableInternalOnlyFeature({
        env: finalGateState.env,
        isIntranet: finalGateState.isIntranet,
      });
    } catch {
      return false;
    }
  })();

  return internalOnlyFeatureVisibilityPromise;
};
```

- [ ] **Step 4: Run the targeted services tests to verify they pass**

Run: `pnpm vitest run packages/services/test/modelProviderService.test.ts packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts`

Expected: PASS with the ZAPI gate behavior preserved and the override-aware helper tests green.

- [ ] **Step 5: Commit the service-side gate wiring**

```bash
git add packages/services/src/node.ts packages/services/test/modelProviderService.test.ts packages/shared/src/internalOnlyFeatureRuntimeEnv.ts packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts packages/shared/src/index.ts
git commit -m "feat(services): honor internal feature env overrides"
```

### Task 4: Run repository verification and update docs if needed

**Files:**
- Modify: `docs/superpowers/specs/2026-04-19-internal-feature-effective-env-override-design.md` (only if implementation diverges from approved design)

- [ ] **Step 1: Run focused unit tests together**

Run: `pnpm vitest run packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts packages/ui/test/remoteConnectionEntryVisibility.test.ts packages/services/test/modelProviderService.test.ts`

Expected: PASS with all targeted tests green.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`

Expected: PASS with no oxlint errors.

- [ ] **Step 4: Update the design doc only if code-level names changed**

```md
- 如果最终落地名不是 `resolveInternalOnlyFeatureGateState`，把 spec 里的 helper 名同步成实现名。
- 如果最终只暴露一个 helper，而不是多个 helper，也同步文档，避免设计与实现漂移。
```

- [ ] **Step 5: Commit the verified implementation**

```bash
git add packages/shared/src/internalOnlyFeatureRuntimeEnv.ts packages/shared/test/internalOnlyFeatureRuntimeEnv.test.ts packages/shared/src/index.ts packages/ui/src/hooks/useInternalOnlyFeatureVisibility.ts packages/ui/test/remoteConnectionEntryVisibility.test.ts packages/services/src/node.ts packages/services/test/modelProviderService.test.ts docs/superpowers/specs/2026-04-19-internal-feature-effective-env-override-design.md
git commit -m "feat: add internal feature runtime env overrides"
```
