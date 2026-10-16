// physical assembly fault 的分类（docs/v4-refactor/04-sync-and-recovery.md 封闭规则 11）。
//
// 恢复阶梯默认把 fault 当瞬态：resync → resume → 强制 snapshot → fail closed。schema 拒收不是
// 瞬态的——字节已经过了 length/checksum/UTF-8/JSON 四道关，被拒说明本端读不懂对端发来的**内容**，
// 而 resume 档只会把同一批 delta 再投一遍。2026-09-21（sess_4142de31）就是这条：一个工具卡载荷
// 多带两个键，阶梯在同一份内容上烧掉三帧后 fail closed，用户手动重连两次、每次再烧三帧。
//
// 本文件钉两件事：分类函数的边界，以及**产出侧与判定侧用的是同一个词**——两处分叉的症状正是
// 这套机制要修的那类静默失配，所以常量化之后要有一条测试真的走一遍 assembler。

import { describe, expect, it } from "vitest";
import {
  conversationTopicFrameSchema,
  isDeterministicContentFault,
  reassembleTopicWireFrames,
  SUBSCRIPTION_CONTENT_REJECTED,
  TopicWireFrameAssembler,
  WIRE_FAULT_INVALID_PAYLOAD,
  type ConversationTopicWireFrame,
} from "../src/zcode-protocol-v4/index.js";

const TOPIC = "conversation/session-wire-fault";
const SUBSCRIPTION_ID = "sub-wire-fault";

/** schema 过不了的帧：payload.kind 不是任何已知分支。 */
function schemaInvalidWire(): ConversationTopicWireFrame {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: "logical-wire-fault",
    logicalFrameOrdinal: 1,
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    frame: {
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 1,
      toSeq: 2,
      sentAt: 1,
      payload: { kind: "not-a-real-payload-kind" },
    },
  } as unknown as ConversationTopicWireFrame;
}

describe("确定性内容 fault 的分类", () => {
  it("只有 schema 拒收算确定性内容失败", () => {
    expect(isDeterministicContentFault(WIRE_FAULT_INVALID_PAYLOAD)).toBe(true);
  });

  // 刻意不把这些算进来：它们可能来自传输或组装路径本身，重投确实可能不同。把瞬态误判成确定性
  // 会让本该自愈的 gap 停在原地，那比多一次无用重试更坏。
  it.each([
    "proto.frameAssemblyInvalidJson",
    "proto.frameAssemblyChecksumMismatch",
    "proto.frameAssemblyLengthMismatch",
    "proto.frameAssemblyTooLarge",
    "proto.frameAssemblyTimedOut",
    "proto.frameAssemblyMetadataMismatch",
    "proto.frameAssemblySuperseded",
  ])("%s 仍按瞬态处理", (reasonCode) => {
    expect(isDeterministicContentFault(reasonCode)).toBe(false);
  });

  it("缺失的 reasonCode 不算确定性失败（未知就按瞬态，保留自愈路径）", () => {
    expect(isDeterministicContentFault(undefined)).toBe(false);
  });

  it("两个终态 code 是不同的词：内容失败不该被聚合成一次链路抖动", () => {
    expect(SUBSCRIPTION_CONTENT_REJECTED).not.toBe("fault.subscription.recoveryFailed");
    // 遥测按 /^fault\.[A-Za-z0-9._-]+$/ 抽 code（useSessionSubscriptionErrorTelemetry），
    // 新 code 必须落在该形状里才会被单独聚合，而不是退成 fault.subscribe.unknown。
    expect(SUBSCRIPTION_CONTENT_REJECTED).toMatch(/^fault\.[A-Za-z0-9._-]+$/);
  });
});

describe("产出侧与判定侧用同一个 reason code", () => {
  it("incremental assembler 的 schema 拒收产出可被判定为内容失败", () => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const events = assembler.accept(schemaInvalidWire());
    const fault = events.find((event) => event.kind === "fault");
    expect(fault).toBeDefined();
    if (fault?.kind !== "fault") return;
    expect(fault.fault.reasonCode).toBe(WIRE_FAULT_INVALID_PAYLOAD);
    expect(isDeterministicContentFault(fault.fault.reasonCode)).toBe(true);
  });

  it("一次性 reassemble 的 schema 拒收同样可被判定", () => {
    const result = reassembleTopicWireFrames([schemaInvalidWire()], conversationTopicFrameSchema);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.reasonCode).toBe(WIRE_FAULT_INVALID_PAYLOAD);
    expect(isDeterministicContentFault(result.reasonCode)).toBe(true);
  });
});
