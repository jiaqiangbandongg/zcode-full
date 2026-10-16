import { describe, expect, it } from "vitest";
import { createCloseEventController } from "../src/remote/closeEvent.js";

describe("close event controller", () => {
  it("先订阅后 fire 时应收到 close code", async () => {
    const controller = createCloseEventController();
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
      controller.fire(17);
    });
    expect(code).toBe(17);
  });

  it("先 fire 后订阅时应补发 close code", async () => {
    const controller = createCloseEventController();
    controller.fire(0);
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
    });
    expect(code).toBe(0);
  });

  it("只应 fire 一次，后续 fire 不覆盖首次结果", async () => {
    const controller = createCloseEventController();
    controller.fire(1);
    controller.fire(2);
    const code = await new Promise<number>((resolve) => {
      controller.event((nextCode) => resolve(nextCode));
    });
    expect(code).toBe(1);
  });
});
