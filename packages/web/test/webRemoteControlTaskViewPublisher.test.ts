import { expect, it, vi } from "vitest";
import { createWebRemoteControlTaskViewPublisher } from "#src/web-remote-control/index.js";

const first = {
  kind: "local" as const,
  bridgeSessionId: "first",
  bridgeGeneration: 1,
  workspacePath: "/one",
  workspaceKey: "/one",
};
const second = {
  kind: "remote" as const,
  bridgeSessionId: "second",
  bridgeGeneration: 2,
  workspacePath: "/one",
  workspaceKey: "remote:server:other:/one",
  workspaceIdentity: "remote:server:other:/one",
  remoteSessionId: "remote",
};
const view = { workspacePath: "/one", taskId: "task" };

it("MRO03：先有可见事实再收到 epoch 仍立即声明，bootstrap 不覆盖更新的 epoch", () => {
  const send = vi.fn(() => true);
  const publisher = createWebRemoteControlTaskViewPublisher(send);
  publisher.setBridge(first);
  publisher.update(first, view);
  expect(send).not.toHaveBeenCalled();
  publisher.request("epoch-new");
  expect(send).toHaveBeenLastCalledWith({
    zcode_type: "mobile-task-view-update",
    epoch: "epoch-new",
    seq: 1,
    bridgeSessionId: "first",
    bridgeGeneration: 1,
    view,
  });
  publisher.seed("epoch-old");
  publisher.flush();
  expect(send).toHaveBeenCalledOnce();
  publisher.update(first, null);
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ epoch: "epoch-new", seq: 2, view: null }),
  );
});

it("MRO03：断连期间更新 Home/隐藏事实，新 epoch 只重申当前事实", () => {
  const send = vi.fn(() => true);
  const publisher = createWebRemoteControlTaskViewPublisher(send);
  publisher.setBridge(first);
  publisher.seed("one");
  publisher.update(first, view);
  publisher.disconnected();
  send.mockClear();
  publisher.update(first, null);
  publisher.flush();
  expect(send).not.toHaveBeenCalled();
  publisher.request("two");
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ epoch: "two", seq: 1, view: null }),
  );
});

it("MRO03：新 Root 不继承旧 bridge 查看，旧 Root cleanup 不能清新查看", () => {
  const send = vi.fn(() => true);
  const publisher = createWebRemoteControlTaskViewPublisher(send);
  publisher.seed("one");
  publisher.setBridge(first);
  publisher.update(first, view);
  publisher.setBridge(second);
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ bridgeSessionId: "second", view: null }),
  );
  const current = { ...view, workspaceIdentity: second.workspaceIdentity };
  publisher.update(second, current);
  const count = send.mock.calls.length;
  publisher.update(first, null);
  publisher.update({ ...second, bridgeGeneration: 1 }, null);
  expect(send).toHaveBeenCalledTimes(count);
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ bridgeSessionId: "second", view: current }),
  );
});

it("MRO03：发送未就绪只保留最新投影，send-ready 不持续重复已成功声明", () => {
  const send = vi.fn(() => false);
  const publisher = createWebRemoteControlTaskViewPublisher(send);
  publisher.setBridge(first);
  publisher.seed("one");
  publisher.update(first, view);
  publisher.update(first, null);
  send.mockReturnValue(true);
  publisher.flush();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ view: null }));
  const count = send.mock.calls.length;
  publisher.flush();
  expect(send).toHaveBeenCalledTimes(count);
});
