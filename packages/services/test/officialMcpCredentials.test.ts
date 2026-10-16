/* OMCP-005/006/009/021/023/024/026/027 —— 官方 MCP 凭证解析与身份头构造（spec §6.1 / §6.2.1 / §6.3.3）。
 *
 * OMCP-025（Off-Peak 零回归，验证 §6.1.1 的隔离）不是本文件的用例，而是一条回归动作：
 *   npx vitest run packages/services/test/offPeakRuntimeModel.test.ts \
 *     packages/services/test/offPeakServerClient.test.ts \
 *     packages/services/test/offPeakTaskService.test.ts \
 *     packages/services/test/offPeakE2eIntegration.test.ts \
 *     packages/services/test/offPeakClientConfig.test.ts \
 *     packages/services/test/offPeakTaskRepo.test.ts
 * 本次实现后为 6 files / 77 tests 全绿，且未修改 offPeakRuntimeModel.ts 的任何导出。
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, type ZCodeAccountAccess } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";

// 凭证解析日志的级别断言（OMCP-LOG-*）：mock 掉 serviceLogger 才能观察到模块级
// `const log` 的调用；该文件其余用例不断言日志，mock 对它们是透明的。
const { serviceInfo } = vi.hoisted(() => ({ serviceInfo: vi.fn() }));

vi.mock("#src/logger/serviceLogger.js", () => ({
  createServiceLogger: () => ({
    debug: vi.fn(),
    info: serviceInfo,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  buildOfficialMcpAuthHeaders,
  createCredentialResolvedLogKey,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
  type OfficialMcpCredentialResolverDeps,
} from "../src/official-mcp/officialMcpCredentials.js";

const JWT = "zcode-jwt-value";
/** MaaS 登录 JWT：Coding Plan 凭证自 2026-08 起走这条通道（X-Bigmodel-Authorization）。 */
const MAAS_JWT = "bigmodel-maas-jwt";
const ZAI_MAAS_JWT = "zai-maas-jwt";

function createRegistry(
  providers: Array<{ providerId: string; config: { access: Record<string, unknown> } }>,
): ModelSelectionView {
  return { revision: 1, providers } as unknown as ModelSelectionView;
}

function individualProvider(family: "zai" | "bigmodel") {
  return {
    providerId:
      family === "zai"
        ? BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    config: {
      access: {
        type: "zhipu-account",
        accountType: family,
        mode: "individual-coding-plan",
        entitled: true,
      },
    },
  };
}

function teamProvider(family: "zai" | "bigmodel") {
  return {
    providerId:
      family === "zai"
        ? BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    config: {
      access: {
        type: "zhipu-account",
        accountType: family,
        mode: "team-coding-plan",
        entitled: true,
      },
    },
  };
}

interface DepsOverrides {
  activeProvider?: string | null;
  activeProviderSequence?: Array<string | null>;
  jwt?: string | null;
  /** 依次返回的 JWT，用于模拟 registry 读取期间的 token 轮换（SG-01）。 */
  jwtSequence?: Array<string | null>;
  /** 覆盖 `oauth:<provider>:access_token`（MaaS 登录 JWT）。 */
  maasJwt?: string | null;
  /** 依次返回的 MaaS JWT，用于模拟它在 registry 读取期间轮换。 */
  maasJwtSequence?: Array<string | null>;
  registry?: ModelSelectionView;
  registrySequence?: ModelSelectionView[];
  settings?: Record<string, unknown>;
  settingsSequence?: Array<Record<string, unknown>>;
  accountAccess?: ZCodeAccountAccess | null;
  accountAccessSequence?: Array<ZCodeAccountAccess | null>;
}

function createDeps(overrides: DepsOverrides = {}): OfficialMcpCredentialResolverDeps {
  let activeProviderCalls = 0;
  let jwtCalls = 0;
  let maasJwtCalls = 0;
  let registryCalls = 0;
  let accountAccessCalls = 0;
  return {
    accountRequestAuthService: {
      resolveAccessCurrent: async (access) => {
        if (overrides.accountAccessSequence) {
          const value =
            overrides.accountAccessSequence[
              Math.min(accountAccessCalls, overrides.accountAccessSequence.length - 1)
            ];
          accountAccessCalls += 1;
          return value ?? null;
        }
        if (overrides.accountAccess !== undefined) return overrides.accountAccess;
        return access.mode === "individual-coding-plan"
          ? {
              type: "zhipu-account" as const,
              family: access.accountType,
              planKind: "individual-coding-plan" as const,
            }
          : null;
      },
    },
    credentialService: {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          if (overrides.activeProviderSequence) {
            const value =
              overrides.activeProviderSequence[
                Math.min(activeProviderCalls, overrides.activeProviderSequence.length - 1)
              ];
            activeProviderCalls += 1;
            return value ?? null;
          }
          return overrides.activeProvider === undefined ? "bigmodel" : overrides.activeProvider;
        }
        if (key === "zcodejwttoken") {
          if (overrides.jwtSequence) {
            const value =
              overrides.jwtSequence[Math.min(jwtCalls, overrides.jwtSequence.length - 1)];
            jwtCalls += 1;
            return value ?? null;
          }
          return overrides.jwt === undefined ? JWT : overrides.jwt;
        }
        // MaaS 登录 JWT 按 family 精确取键，禁止跨 family 回退。
        if (key === "oauth:bigmodel:access_token" || key === "oauth:zai:access_token") {
          if (overrides.maasJwtSequence) {
            const value =
              overrides.maasJwtSequence[
                Math.min(maasJwtCalls, overrides.maasJwtSequence.length - 1)
              ];
            maasJwtCalls += 1;
            return value ?? null;
          }
          if (overrides.maasJwt !== undefined) return overrides.maasJwt;
          return key === "oauth:zai:access_token" ? ZAI_MAAS_JWT : MAAS_JWT;
        }
        return null;
      },
    },
    modelSelectionService: {
      getView: async () => {
        const fallback = overrides.registry ?? createRegistry([individualProvider("bigmodel")]);
        const value =
          overrides.registrySequence?.[
            Math.min(registryCalls, overrides.registrySequence.length - 1)
          ];
        registryCalls += 1;
        return value ?? fallback;
      },
    },
  };
}

describe("official mcp credential resolver", () => {
  it("OMCP-021: emits PERSONAL target type for a personal coding plan", async () => {
    const outcome = await resolveOfficialMcpCredentials(createDeps());
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.planScope).toEqual({ targetType: "PERSONAL" });
    expect(outcome.snapshot.wireScope).toEqual({ targetType: "PERSONAL" });
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
      "Bigmodel-Target-Type": "PERSONAL",
      "X-Bigmodel-Authorization": `Bearer ${MAAS_JWT}`,
    });
    // 旧通道必须彻底消失：两个头同时发会让服务端额外校验 API key 归属，
    // 一把过期 key 就能让整个请求 403。
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)["X-Coding-Plan-Api-Key"]).toBeUndefined();
  });

  it("OMCP-005/021: emits TEAM target type with paired identity for a BigModel team plan", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([teamProvider("bigmodel")]),
        accountAccess: {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "team-coding-plan",
          productId: "coding",
          organizationId: "org-1",
          projectId: "project-1",
        },
        settings: {
          providerFamilyConnectionSelections: {
            bigmodel: {
              kind: "team-coding-plan",
              productId: "coding",
              organizationId: "org-1",
              projectId: "project-1",
            },
          },
          providerFamilyDomain: "bigmodel",
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot).toMatchObject({
      planScope: {
        organizationId: "org-1",
        projectId: "project-1",
        targetType: "TEAM",
      },
      wireScope: {
        organizationId: "org-1",
        projectId: "project-1",
        targetType: "TEAM",
      },
    });
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
      "Bigmodel-Organization": "org-1",
      "Bigmodel-Project": "project-1",
      "Bigmodel-Target-Type": "TEAM",
      "X-Bigmodel-Authorization": `Bearer ${MAAS_JWT}`,
    });
  });

  it("OMCP-006: wireScope=null never emits partial team headers", () => {
    expect(
      buildOfficialMcpAuthHeaders({
        codingPlanAuthorization: MAAS_JWT,
        jwt: JWT,
        planScope: null,
        providerFamily: "bigmodel",
        wireScope: null,
      }),
    ).toEqual({
      Authorization: `Bearer ${JWT}`,
      "X-Bigmodel-Authorization": `Bearer ${MAAS_JWT}`,
    });
  });

  it("OMCP-021: keeps zai-team consistent with Off-Peak by omitting Target-Type entirely", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        activeProvider: "zai",
        registry: createRegistry([teamProvider("zai")]),
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          planKind: "team-coding-plan",
          productId: "coding",
          organizationId: "org-z",
          projectId: "project-z",
        },
        settings: {
          providerFamilyConnectionSelections: {
            zai: {
              kind: "team-coding-plan",
              productId: "coding",
              organizationId: "org-z",
              projectId: "project-z",
            },
          },
          providerFamilyDomain: "zai",
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.planScope).toEqual({
      organizationId: "org-z",
      projectId: "project-z",
      targetType: "TEAM",
    });
    expect(outcome.snapshot.wireScope).toBeNull();
    const headers = buildOfficialMcpAuthHeaders(outcome.snapshot);
    expect(headers["Bigmodel-Target-Type"]).toBeUndefined();
    expect(headers["Bigmodel-Organization"]).toBeUndefined();
    expect(headers["Bigmodel-Project"]).toBeUndefined();
  });

  it("OMCP-023: sends only the ZCode JWT for a Start Plan connection", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
            config: {
              access: {
                type: "zhipu-account",
                family: "bigmodel",
                mode: "start-plan",
              },
            },
          },
        ]),
      }),
    );
    expect(outcome).toEqual({
      ok: true,
      snapshot: {
        jwt: JWT,
        planScope: null,
        providerFamily: "bigmodel",
        wireScope: null,
      },
    });
    if (!outcome.ok) return;
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
    });
  });

  it("OMCP-009: reports unavailable when not logged in and plan-required without Account Access", async () => {
    await expect(resolveOfficialMcpCredentials(createDeps({ jwt: "" }))).resolves.toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    await expect(
      resolveOfficialMcpCredentials(
        createDeps({
          accountAccess: null,
          registry: createRegistry([individualProvider("bigmodel")]),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "official_auth_plan_required" });
  });

  it("rejects a login identity that does not match the selected family", async () => {
    // ZAI JWT + BigModel key 拼进同一请求，服务端只能在业务校验时才拒绝，这里提前挡掉。
    await expect(
      resolveOfficialMcpCredentials(createDeps({ activeProvider: "zai" })),
    ).resolves.toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("sends only the ZCode JWT when the selected coding plan connection is absent", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ registry: createRegistry([]) }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
    });
  });

  it("does not require a MaaS JWT when no Coding Plan provider is selected", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ maasJwt: null, registry: createRegistry([]) }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.codingPlanAuthorization).toBeUndefined();
  });

  it("rejects an identity-only snapshot while the active provider remains unstable", async () => {
    await expect(
      resolveOfficialMcpCredentials(
        createDeps({
          activeProviderSequence: ["bigmodel", "zai", "bigmodel", "zai"],
          registry: createRegistry([]),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("still resolves when the connection exists but its business key is absent", async () => {
    // 行为变更（2026-08）：业务 key 不再是凭证，因此不再当门槛。此前"key 正在刷新"的瞬态
    // 会被误判成"没有套餐"，把一次本可成功的调用挡在本地。
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([individualProvider("bigmodel")]),
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)["X-Bigmodel-Authorization"]).toBe(
      `Bearer ${MAAS_JWT}`,
    );
  });

  it("reports official_auth_unavailable when the MaaS login JWT is missing", async () => {
    // 登录态不完整（需重新登录），不是"没有套餐"——两个 provider adapter 登录时都硬性要求
    // 写入该 token，因此这主要出现在历史迁移过来的旧登录态上。
    await expect(resolveOfficialMcpCredentials(createDeps({ maasJwt: "" }))).resolves.toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
  });

  it("takes the MaaS JWT of the selected family, never the other one", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        activeProvider: "zai",
        registry: createRegistry([individualProvider("zai")]),
        settings: {
          providerFamilyConnectionSelections: {
            zai: { kind: "individual-coding-plan" },
          },
          providerFamilyDomain: "zai",
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    // 跨 family 回退会发出一次注定失败的请求，且失败原因会指向"没有套餐"这种误导结论。
    expect(outcome.snapshot.codingPlanAuthorization).toBe(ZAI_MAAS_JWT);
    expect(outcome.snapshot.codingPlanAuthorization).not.toBe(MAAS_JWT);
  });

  it("re-resolves once when the selection changes mid-flight, then gives up", async () => {
    // 前后指纹不一致必须重来，绝不拼接两代凭证。两轮都不稳定则按不可用返回。
    const flipping = [
      createRegistry([individualProvider("bigmodel")]),
      createRegistry([individualProvider("zai")]),
    ];
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ registrySequence: [flipping[0]!, flipping[1]!, flipping[0]!, flipping[1]!] }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("动态 Team scope 在解析前后变化时不拼接两代身份", async () => {
    const teamAccess = (projectId: string): ZCodeAccountAccess => ({
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "team-coding-plan",
      productId: "coding",
      organizationId: "org-1",
      projectId,
    });
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([teamProvider("bigmodel")]),
        accountAccessSequence: [
          teamAccess("project-a"),
          teamAccess("project-b"),
          teamAccess("project-a"),
          teamAccess("project-b"),
        ],
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("SG-01: discards the round when the JWT rotates during the registry read", async () => {
    // 读取顺序：每轮 首次 JWT -> registry -> 二次一致性检查再读 JWT。
    // 四个互不相同的值让**两轮**的前后读取都不一致 => 按不可用返回，
    // 绝不产出"旧 JWT + 新 key"的混代快照。
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        jwtSequence: ["jwt-gen-1", "jwt-gen-2", "jwt-gen-3", "jwt-gen-4"],
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("discards the round when the MaaS JWT rotates during the registry read", async () => {
    // 与上一条同理：MaaS JWT 现在是真正的 Coding Plan 凭证，必须一起纳入前后一致性检查，
    // 否则会拼出"旧 zcode JWT + 新 MaaS JWT"的混代快照。
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        maasJwtSequence: ["maas-gen-1", "maas-gen-2", "maas-gen-3", "maas-gen-4"],
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("SG-01: accepts the snapshot when the JWT stays stable across the registry read", async () => {
    // 第 1、2 次读取一致（同一代），必须成功且快照使用该 JWT。
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ jwtSequence: ["jwt-stable", "jwt-stable"] }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.jwt).toBe("jwt-stable");
  });

  it("SG-01: recovers when the JWT rotates once and then settles", async () => {
    // 第一轮不一致（gen1 -> gen2），第二轮稳定在 gen2 => 最终成功且用 gen2。
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ jwtSequence: ["jwt-gen-1", "jwt-gen-2", "jwt-gen-2", "jwt-gen-2"] }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.jwt).toBe("jwt-gen-2");
  });

  it("OMCP-024: has no mock credential branch at all", async () => {
    // Off-Peak 的 ZCODE_OFFPEAK_MOCK 占位凭证分支不得在官方 MCP 路径复现。
    const previous = process.env["ZCODE_OFFPEAK_MOCK"];
    process.env["ZCODE_OFFPEAK_MOCK"] = "1";
    try {
      const outcome = await resolveOfficialMcpCredentials(createDeps({ jwt: "" }));
      expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
      const ok = await resolveOfficialMcpCredentials(createDeps());
      expect(ok).toMatchObject({ ok: true });
      if (!ok.ok) return;
      expect(ok.snapshot.jwt).toBe(JWT);
      expect(ok.snapshot.codingPlanAuthorization).toBe(MAAS_JWT);
    } finally {
      if (previous === undefined) delete process.env["ZCODE_OFFPEAK_MOCK"];
      else process.env["ZCODE_OFFPEAK_MOCK"] = previous;
    }
  });

  it("OMCP-026: dedupes concurrent resolves into a single underlying resolution", async () => {
    const deps = createDeps();
    const spy = vi.spyOn(deps.modelSelectionService, "getView");
    const resolver = createOfficialMcpAuthHeadersResolver(deps);
    const results = await Promise.all([
      resolver.resolveHeaders(),
      resolver.resolveHeaders(),
      resolver.resolveHeaders(),
      resolver.resolveHeaders(),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
  });

  it("OMCP-027: re-resolves after settle, so a connection switch is picked up", async () => {
    const deps = createDeps();
    const spy = vi.spyOn(deps.modelSelectionService, "getView");
    const resolver = createOfficialMcpAuthHeadersResolver(deps);
    await resolver.resolveHeaders();
    await resolver.resolveHeaders();
    // 无时间维度缓存：顺序两次调用必须各解析一遍
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("clears the in-flight slot when a resolution throws", async () => {
    let shouldThrow = true;
    const deps = createDeps();
    deps.modelSelectionService.getView = async () => {
      if (shouldThrow) throw new Error("registry unavailable");
      return createRegistry([individualProvider("bigmodel")]);
    };
    const resolver = createOfficialMcpAuthHeadersResolver(deps);
    await expect(resolver.resolveHeaders()).rejects.toThrow("registry unavailable");
    shouldThrow = false;
    // 失败的 Promise 不得被后续请求永久复用
    await expect(resolver.resolveHeaders()).resolves.toMatchObject({ ok: true });
  });
});

/* OMCP-LOG —— 凭证解析成功日志：info 级 + 小时分桶去重（spec §4 审计规则）。
 *
 * 背景：MaaS JWT 无刷新链路，过期被服务端 3101 折叠成 "coding plan is required"（2026-09-12
 * 用户事故），剩余有效期是客户端唯一可自证的线索，因此必须 info（生产 debug 不落盘）；
 * 但解析与官方 MCP 请求数同数量级，必须去重（见 createCredentialResolvedLogKey）。
 */
describe("official mcp credential resolved log", () => {
  it("OMCP-LOG-01: dedup key buckets expiry by hour and separates family/scope", () => {
    const personal = { providerFamily: "bigmodel", planTargetType: "PERSONAL" } as const;
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: 3600 }),
    ).toBe("bigmodel|PERSONAL|t1");
    // 桶边界：3599 落在 t0，跨过 3600 进入 t1
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: 3599 }),
    ).toBe("bigmodel|PERSONAL|t0");
    // 过期（≤0）与解析失败（undefined）是独立桶：跨过零点、token 形态变化必落新键
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: -5 }),
    ).toBe("bigmodel|PERSONAL|expired");
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: undefined }),
    ).toBe("bigmodel|PERSONAL|unparsable");
    expect(
      createCredentialResolvedLogKey({
        providerFamily: "zai",
        planTargetType: null,
        maasJwtExpiresInSeconds: 100,
      }),
    ).toBe("zai|none|t0");
    // PERSONAL↔TEAM 切换是身份头语义变化，必须可分辨
    expect(
      createCredentialResolvedLogKey({
        providerFamily: "zai",
        planTargetType: "TEAM",
        maasJwtExpiresInSeconds: 100,
      }),
    ).not.toBe(
      createCredentialResolvedLogKey({
        providerFamily: "zai",
        planTargetType: "PERSONAL",
        maasJwtExpiresInSeconds: 100,
      }),
    );
  });

  it("OMCP-LOG-02: logs jwt expiry at info level and dedupes same-bucket re-resolves", async () => {
    // 123456s ≈ 34.3h → t34 桶：本文件其他用例都用解析不出 exp 的假 token（unparsable
    // 桶），独特桶值保证本用例首调不被模块级去重键吞掉，用例间不依赖执行顺序。
    const deps = createDeps({ maasJwt: makeMaasJwtWithExpiry(123456) });
    serviceInfo.mockClear();
    const first = await resolveOfficialMcpCredentials(deps);
    expect(first.ok).toBe(true);
    const resolvedCalls = () =>
      serviceInfo.mock.calls.filter(
        (call): call is [string, Record<string, unknown>] =>
          call[0] === "official mcp credentials resolved",
      );
    expect(resolvedCalls()).toHaveLength(1);
    const fields = resolvedCalls()[0]![1]!;
    expect(fields).toMatchObject({
      providerFamily: "bigmodel",
      planTargetType: "PERSONAL",
      wireTargetType: "PERSONAL",
    });
    expect(fields["maasJwtExpiresInSeconds"]).toBeGreaterThan(123_000);
    expect(fields["maasJwtExpiresInSeconds"]).toBeLessThan(123_900);

    // resolver 无时间缓存，同一桶内重复解析（两次构造 token 相差 0~1s，同落 t34）
    // 不得重复记录——否则日志量与官方 MCP 请求数同数量级。
    const second = await resolveOfficialMcpCredentials(
      createDeps({ maasJwt: makeMaasJwtWithExpiry(123456) }),
    );
    expect(second.ok).toBe(true);
    expect(resolvedCalls()).toHaveLength(1);
  });

  it("OMCP-LOG-03: identity-only degradation stays out of info logs", async () => {
    // 已登录但 Registry 无 coding plan provider → identity-only 降级仍走 debug，
    // 不产生 info 噪音（本次升级范围仅限带 MaaS JWT 的成功解析）。
    const deps = createDeps({ registry: createRegistry([]) });
    const outcome = await resolveOfficialMcpCredentials(deps);
    expect(outcome).toMatchObject({ ok: true });
    expect(
      serviceInfo.mock.calls.filter((call) => String(call[0]).includes("identity-only")),
    ).toHaveLength(0);
  });
});

/** 造一个能被 readJwtExpiresInSeconds 解析出 exp 的三段式 MaaS JWT（base64url payload）。 */
function makeMaasJwtWithExpiry(expiresInSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.round(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}
