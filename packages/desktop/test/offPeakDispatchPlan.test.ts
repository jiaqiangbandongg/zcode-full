import { describe, expect, it } from "vitest";
import { OffPeakPermanentDispatchError } from "@zcode/services/node";
import {
  assertBoundSessionDispatchable,
  OffPeakBoundSessionBusyError,
  OffPeakBoundSessionDeletedError,
  resolveOffPeakDispatchKind,
} from "../src/host/offPeakDispatchPlan.js";

describe("resolveOffPeakDispatchKind（D50 绑定首跑分支）", () => {
  it("conversationId 已回填 → 续跑；仅 sessionId → 绑定首跑；两者皆空 → 新建 session", () => {
    expect(resolveOffPeakDispatchKind({ conversationId: "sess", sessionId: "sess" })).toBe("resume");
    expect(resolveOffPeakDispatchKind({ sessionId: "sess" })).toBe("bound-first-run");
    expect(resolveOffPeakDispatchKind({})).toBe("init");
    expect(resolveOffPeakDispatchKind({ sessionId: "  " })).toBe("init");
  });
});

describe("assertBoundSessionDispatchable", () => {
  it("会话已删除 → permanent（不再退避重试）", () => {
    expect(() =>
      assertBoundSessionDispatchable({ sessionId: "sess", deleted: true, running: false }),
    ).toThrow(OffPeakBoundSessionDeletedError);
    expect(new OffPeakBoundSessionDeletedError("sess")).toBeInstanceOf(OffPeakPermanentDispatchError);
  });

  it("会话正忙 → transient busy，且不是 permanent", () => {
    expect(() =>
      assertBoundSessionDispatchable({ sessionId: "sess", deleted: false, running: true }),
    ).toThrow(OffPeakBoundSessionBusyError);
    expect(new OffPeakBoundSessionBusyError("sess")).not.toBeInstanceOf(
      OffPeakPermanentDispatchError,
    );
  });

  it("空闲且存在 → 放行", () => {
    expect(() =>
      assertBoundSessionDispatchable({ sessionId: "sess", deleted: false, running: false }),
    ).not.toThrow();
  });
});
