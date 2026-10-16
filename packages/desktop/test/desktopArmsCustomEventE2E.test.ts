import { describe, expect, it, vi } from "vitest";
import { shouldEnableE2ETestBridge } from "@zcode/shared";
import {
  createFinalArmsCustomEventE2EController,
  dispatchFinalArmsCustomEvent,
} from "../src/main/desktopArmsCustomEvent.js";

const context = {
  deviceMid: "device-1",
  platform: "darwin" as const,
  appVersion: "9.8.7",
  armsEnv: "local" as const,
  rendererId: 42,
};

describe("desktop final ARMS custom E2E bridge", () => {
  it("只有 build flag 与真实 E2E runner 同时存在才开启", () => {
    expect(shouldEnableE2ETestBridge({})).toBe(false);
    expect(
      shouldEnableE2ETestBridge({
        VITE_ZCODE_E2E_STORE_BRIDGE: "1",
      }),
    ).toBe(false);
    expect(
      shouldEnableE2ETestBridge({
        ZCODE_E2E_RUN_ID: "run-1",
      }),
    ).toBe(false);
    expect(
      shouldEnableE2ETestBridge({
        VITE_ZCODE_E2E_STORE_BRIDGE: "1",
        ZCODE_E2E_RUN_ID: "run-1",
      }),
    ).toBe(true);
  });

  it("捕获 main 补齐后的最终参数，并只抑制命中的目标事件", () => {
    let now = 1_000;
    const controller = createFinalArmsCustomEventE2EController({
      now: () => now,
    });
    const sendCustom = vi.fn();
    controller.configure({ suppressedEventNames: ["plan_ttft"] });

    const dispatched = dispatchFinalArmsCustomEvent({
      payload: {
        name: "plan_ttft",
        group: "plan_usage",
        value: 123,
        properties: {
          talk_id: "session-1",
          waiting_tool: false,
        },
      },
      context,
      e2eController: controller,
      sendCustom,
    });

    expect(dispatched.suppressed).toBe(true);
    expect(sendCustom).not.toHaveBeenCalled();
    expect(controller.read()).toEqual([
      {
        sequence: 1,
        recordedAt: 1_000,
        payload: {
          name: "plan_ttft",
          type: "custom",
          group: "plan_usage",
          value: 123,
          properties: {
            event_name: "plan_ttft",
            app_version: "9.8.7",
            arms_env: "local",
            device_mid: "device-1",
            platform: "macos",
            renderer_id: "42",
            metric_value: "123",
            talk_id: "session-1",
            waiting_tool: "false",
          },
        },
      },
    ]);

    now = 1_001;
    dispatchFinalArmsCustomEvent({
      payload: { name: "perf_ui_message_complete", group: "ui_perf" },
      context,
      e2eController: controller,
      sendCustom,
    });
    expect(sendCustom).toHaveBeenCalledOnce();
    expect(sendCustom.mock.calls[0]?.[0]).toMatchObject({
      name: "perf_ui_message_complete",
      value: 1,
      properties: { metric_value: "1" },
    });
    expect(controller.read()[1]?.payload).toEqual(sendCustom.mock.calls[0]?.[0]);
  });

  it("ring 有界、读取返回副本，clear 不持久化历史", () => {
    const controller = createFinalArmsCustomEventE2EController({
      capacity: 2,
      now: () => 7,
    });
    const sendCustom = vi.fn();
    for (const name of ["event-1", "event-2", "event-3"]) {
      dispatchFinalArmsCustomEvent({
        payload: { name, group: "test" },
        context,
        e2eController: controller,
        sendCustom,
      });
    }

    const firstRead = controller.read();
    expect(firstRead.map((entry) => entry.payload.name)).toEqual(["event-2", "event-3"]);
    expect(firstRead.map((entry) => entry.sequence)).toEqual([2, 3]);
    firstRead[0]!.payload.properties.app_version = "mutated";
    expect(controller.read()[0]?.payload.properties.app_version).toBe("9.8.7");

    controller.clear();
    expect(controller.read()).toEqual([]);
  });

  it("拒绝无界或非法 suppression 配置", () => {
    const controller = createFinalArmsCustomEventE2EController();
    expect(() =>
      controller.configure({
        suppressedEventNames: Array.from({ length: 101 }, (_, index) => `event-${index}`),
      }),
    ).toThrow("最多 100 项");
    expect(() => controller.configure({ suppressedEventNames: [""] })).toThrow("空值");
  });
});
