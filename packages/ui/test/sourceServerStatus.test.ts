import { describe, expect, it } from "vitest";
import {
  aggregateSourceStatus,
  buildAggregatedSourceStatusMap,
} from "@/lib/remoteConnectionPresentation.js";

describe("aggregateSourceStatus", () => {
  it("uses semantic precedence instead of input order", () => {
    expect(
      aggregateSourceStatus([
        { state: "offline" },
        { state: "bootstrapping" },
        { state: "identity-change-pending" },
      ]),
    ).toBe("connecting");
    expect(aggregateSourceStatus([{ state: "offline" }, { state: "needs-upgrade" }])).toBe(
      "pending",
    );
    expect(aggregateSourceStatus([{ state: "failed" }, { state: "offline" }])).toBe("failed");
    expect(aggregateSourceStatus([{ state: "offline" }])).toBe("offline");
  });

  it("builds one Source status map from active profiles only", () => {
    expect(
      buildAggregatedSourceStatusMap({
        servers: [{ sourceServerId: "source-1" }],
        profiles: [
          {
            profileId: "active",
            sourceServerId: "source-1",
            lifecycleState: "active",
          },
          {
            profileId: "retired",
            sourceServerId: "source-1",
            lifecycleState: "retired",
          },
        ],
        states: [
          { profileId: "active", state: "offline" },
          { profileId: "retired", state: "online" },
        ],
      } as never),
    ).toEqual(new Map([["source-1", "offline"]]));
  });
});
