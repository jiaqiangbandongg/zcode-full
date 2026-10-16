// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NetworkSection } from "@/resource-manager/NetworkSection.js";
import type { NetworkCaptureSnapshot } from "@zcode/shared";
const { intl } = vi.hoisted(() => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }));
vi.mock("@/i18n/index.js", () => ({ useZCodeIntl: () => ({ intl, locale: "zh-CN" }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("只串行拉取投影，清空拒绝旧快照，卸载停止计时器", async () => {
  vi.useFakeTimers();
  let resolve!: (snapshot: NetworkCaptureSnapshot) => void;
  const old = new Promise<NetworkCaptureSnapshot>((done) => {
    resolve = done;
  });
  const empty = { captureId: "one", records: [], dropped: 0 };
  const bridge = {
    getSnapshot: vi.fn().mockReturnValueOnce(old).mockResolvedValue(empty),
    clear: vi.fn(async () => {}),
  };
  const view = render(createElement(NetworkSection, { bridge }));
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(bridge.getSnapshot).toHaveBeenCalledTimes(1);
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "resourceManager.network.clear" })),
  );
  await act(async () =>
    resolve({
      captureId: "one",
      dropped: 0,
      records: [
        {
          id: 1,
          timestamp: 1,
          pid: 42,
          processType: "main",
          method: "GET",
          url: "https://old-request.test/",
        },
      ],
    }),
  );
  expect(view.queryByText("https://old-request.test/")).toBeNull();
  view.unmount();
  const count = bridge.getSnapshot.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(bridge.getSnapshot).toHaveBeenCalledTimes(count);
});
