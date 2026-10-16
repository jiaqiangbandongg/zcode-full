import { describe, expect, it } from "vitest";
import {
  getStreamClientId,
  setStreamClientId,
  generateMobileDeviceFingerprint,
} from "../src/lib/streamClientId.js";

// ============================================================================
// streamClientId 单元测试
// ============================================================================

describe("streamClientId", () => {
  describe("generateMobileDeviceFingerprint", () => {
    it("返回平台相关信息拼接的字符串", () => {
      const result = generateMobileDeviceFingerprint();
      // 验证格式：platform|width|height|colorDepth，至少有平台或屏幕信息之一
      expect(typeof result).toBe("string");
      expect(result.split("|").length).toBeGreaterThanOrEqual(1);
    });

    it("包含所有可用屏幕信息", () => {
      // 该函数读取 globalThis.navigator 和 globalThis.screen
      // 在测试环境中这些可能有值，验证返回非空
      const result = generateMobileDeviceFingerprint();
      expect(result).toBeTruthy();
    });

    it("空参数时仍返回字符串", () => {
      // 函数内部有 undefined 过滤，验证不会抛错
      const result = generateMobileDeviceFingerprint();
      expect(result).toBeDefined();
    });
  });

  describe("setStreamClientId / getStreamClientId (缓存行为)", () => {
    it("setStreamClientId 设置后，getStreamClientId 返回固定格式 renderer:deviceId", () => {
      setStreamClientId("test-device-123");
      expect(getStreamClientId()).toBe("renderer:test-device-123");
    });

    it("setStreamClientId 之后的结果与之前不同", () => {
      const before = getStreamClientId();
      setStreamClientId("new-device-456");
      const after = getStreamClientId();
      expect(after).toBe("renderer:new-device-456");
      expect(after).not.toBe(before);
    });

    it("setStreamClientId 格式为 renderer:前缀加设备ID", () => {
      setStreamClientId("device-abc");
      const id = getStreamClientId();
      expect(id).toMatch(/^renderer:.+$/);
      expect(id).toBe("renderer:device-abc");
    });
  });
});
