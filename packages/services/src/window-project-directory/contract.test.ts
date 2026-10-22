import { Emitter } from "@zcode/rpc";
import { expect, it, vi } from "vitest";
import { createWindowProjectChangesService } from "#src/window-project-directory/index.js";

it("窗口变化流只透传项目失效，取消后释放原广播监听", async () => {
  const event = new Emitter<{ channel: string; payload: unknown }>();
  const service = createWindowProjectChangesService({ onMessage: event.event });
  const changed = vi.fn();
  const subscription = service.onDidChange(changed);
  expect(await service.getCapabilities()).toEqual({ version: 1 });
  event.fire({ channel: "state:theme", payload: {} });
  expect(changed).not.toHaveBeenCalled();
  event.fire({ channel: "state:projects", payload: {} });
  expect(changed).toHaveBeenCalledOnce();
  subscription.dispose();
  event.fire({ channel: "state:projects", payload: {} });
  expect(changed).toHaveBeenCalledOnce();
  event.dispose();
});
