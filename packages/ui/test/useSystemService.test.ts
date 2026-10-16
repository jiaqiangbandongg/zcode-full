import { describe, expect, it } from "vitest";
import {
  INTRANET_MACHINE_HOST,
  INTRANET_PROBE_SERVICE_PORT,
  type IntranetProbeRequest,
} from "@zcode/shared";
import {
  createIntranetProbeRequestStableKey,
  shouldApplyIntranetProbeRunResult,
} from "@/hooks/useSystemService.js";

describe("useSystemService intranet probe request key", () => {
  it("生成稳定 key，避免同内容 inline request 触发重复自动探测", () => {
    const requestA: IntranetProbeRequest = {
      attempts: 2,
      requiredSuccessCount: 1,
      targets: [
        {
          host: INTRANET_MACHINE_HOST,
          port: INTRANET_PROBE_SERVICE_PORT,
          timeoutMs: 800,
        },
        {
          kind: "service",
          url: `http://${INTRANET_MACHINE_HOST}:${INTRANET_PROBE_SERVICE_PORT}/healthz`,
          expectedMarker: "zcode-intranet",
          token: "probe-token",
        },
      ],
    };

    const requestB: IntranetProbeRequest = {
      attempts: 2,
      requiredSuccessCount: 1,
      targets: [
        {
          host: INTRANET_MACHINE_HOST,
          port: INTRANET_PROBE_SERVICE_PORT,
          timeoutMs: 800,
        },
        {
          kind: "service",
          url: `http://${INTRANET_MACHINE_HOST}:${INTRANET_PROBE_SERVICE_PORT}/healthz`,
          expectedMarker: "zcode-intranet",
          token: "probe-token",
        },
      ],
    };

    expect(createIntranetProbeRequestStableKey(requestA)).toBe(
      createIntranetProbeRequestStableKey(requestB),
    );
  });

  it("request 内容变化时 key 也要变化", () => {
    const requestA: IntranetProbeRequest = {
      targets: [{ host: INTRANET_MACHINE_HOST, port: INTRANET_PROBE_SERVICE_PORT }],
    };
    const requestB: IntranetProbeRequest = {
      targets: [{ host: "10.0.0.101", port: 3850 }],
    };

    expect(createIntranetProbeRequestStableKey(requestA)).not.toBe(
      createIntranetProbeRequestStableKey(requestB),
    );
  });
});

describe("useSystemService intranet probe run guard", () => {
  it("只允许最新一次探测写回结果", () => {
    const latestRunId = 2;
    expect(shouldApplyIntranetProbeRunResult(1, latestRunId)).toBe(false);
    expect(shouldApplyIntranetProbeRunResult(2, latestRunId)).toBe(true);
  });
});
