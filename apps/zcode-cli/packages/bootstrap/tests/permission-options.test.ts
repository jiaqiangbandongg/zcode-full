import { describe, expect, it } from "vitest";
import {
  buildProtocolPermissionOptions,
  buildSessionPermissionUpdates,
  toLegacyPermissionOptionsPolicy,
} from "../src/permission-options.js";

describe("buildProtocolPermissionOptions", () => {
  it("offers allow once, always allow in project, and deny by default", () => {
    const options = buildProtocolPermissionOptions({
      input: { file_path: "/workspace/a.ts" },
      toolName: "Edit",
    });

    expect(options.map((option) => option.kind)).toEqual([
      "allow_once",
      "allow_always",
      "deny",
    ]);
    const always = options.find((option) => option.kind === "allow_always");
    expect(always?.response.permissionUpdates?.[0]?.rules[0]).toMatchObject({
      toolName: "Edit",
      ruleContent: "/workspace/a.ts",
    });
  });

  it("drops always allow when the tool declares no-always-allow", () => {
    const options = buildProtocolPermissionOptions({
      input: { script: 'return await agent("a").ask<string>("x");' },
      optionsPolicy: "no-always-allow",
      toolName: "CreateWorkflow",
    });

    expect(options.map((option) => option.kind)).toEqual(["allow_once", "deny"]);
    expect(options.some((option) => option.optionId === "allow_project")).toBe(false);
  });

  // 第 7 轮（2026-09-11）：会话作用域的免确认替换项目级 always allow。
  it("replaces the project rule with a session-scoped option under session-always-allow", () => {
    const options = buildProtocolPermissionOptions({
      input: { script: 'return await agent("a").ask<string>("x");' },
      optionsPolicy: "session-always-allow",
      toolName: "CreateWorkflow",
    });

    expect(options.map((option) => option.kind)).toEqual([
      "allow_once",
      "allow_session",
      "deny",
    ]);
    const session = options.find((option) => option.kind === "allow_session");
    expect(session).toMatchObject({
      optionId: "allowSession",
      name: "Always allow in this session",
      response: { decision: "allow" },
    });
    // wire 上 zcodePermissionUpdateSchema 是 strict：会话语义不能借 permissionUpdates 走私，
    // 会话授权由 broker 在应答侧合成（sessionPermissionUpdates）。
    expect(session?.response).not.toHaveProperty("permissionUpdates");
    expect(options.some((option) => option.optionId === "allow_project")).toBe(false);
  });

  it("builds session updates that grant the whole tool, not one script", () => {
    expect(buildSessionPermissionUpdates("CreateWorkflow")).toEqual([
      { behavior: "allow", rules: [{ toolName: "CreateWorkflow" }], type: "addRules" },
    ]);
  });

  // legacy v3 认不出会话语义（回传 response 原文），降为只裁掉 always allow。
  it("degrades session-always-allow to no-always-allow for legacy consumers", () => {
    expect(toLegacyPermissionOptionsPolicy("session-always-allow")).toBe("no-always-allow");
    expect(toLegacyPermissionOptionsPolicy("no-always-allow")).toBe("no-always-allow");
    expect(toLegacyPermissionOptionsPolicy(undefined)).toBeUndefined();
  });
});
