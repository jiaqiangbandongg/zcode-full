import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  PERMISSION_INTERACTION_PREFIX,
  readPermissionInteractionIdsInBrowser,
} from "./e2e/helpers/permission-interaction-id.js";

function readIds(entries: Array<{ id: string; visible: boolean }>): string[] {
  const nodes = entries.map(({ id, visible }) => ({
    dataset: { testid: id },
    getClientRects: () => (visible ? [1] : []),
    getAttribute: (name: string) => (name === "data-testid" ? id : null),
  }));
  return runInNewContext(`(${readPermissionInteractionIdsInBrowser.toString()})(prefix)`, {
    prefix: PERMISSION_INTERACTION_PREFIX,
    __name: (value: unknown) => value,
    document: {
      querySelector: () => nodes.find((node) => node.dataset.testid.startsWith("v4-permission")),
      querySelectorAll: () => nodes,
    },
  });
}

describe("权限恢复的真实请求身份", () => {
  it("同一对话框中的不同 interaction 不能误判为同一个请求", () => {
    const generic = { id: "v4-permission-dialog", visible: true };
    expect(
      readIds([generic, { id: `${PERMISSION_INTERACTION_PREFIX}request-a`, visible: true }]),
    ).toEqual(["request-a"]);
    expect(
      readIds([generic, { id: `${PERMISSION_INTERACTION_PREFIX}request-b`, visible: true }]),
    ).toEqual(["request-b"]);
  });
  it("通用 ID、隐藏的旧请求和普通工具摘要都不能补充请求身份", () => {
    expect(
      readIds([
        { id: "v4-permission-dialog", visible: true },
        { id: `${PERMISSION_INTERACTION_PREFIX}old`, visible: false },
        { id: "tool-summary-trigger-normal-tool", visible: true },
      ]),
    ).toEqual([]);
  });
  it("重复摘要去重，多个不同可见请求保留以拒绝歧义", () => {
    expect(
      readIds([
        { id: `${PERMISSION_INTERACTION_PREFIX}a`, visible: true },
        { id: `${PERMISSION_INTERACTION_PREFIX}a`, visible: true },
        { id: `${PERMISSION_INTERACTION_PREFIX}b`, visible: true },
      ]),
    ).toEqual(["a", "b"]);
  });
});
