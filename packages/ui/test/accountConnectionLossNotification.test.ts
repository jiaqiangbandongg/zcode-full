// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccountConnectionLossNotification } from "@/root/useAccountConnectionLossNotification.js";
const mocks = vi.hoisted(() => ({
  toast: vi.fn((_message: string, _options?: { onAction?: () => void; actionLabel?: string }) => 1),
  dismissToast: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(async () => "switched"),
}));
vi.mock("@/components/ui/toast.js", () => ({
  toast: mocks.toast,
  dismissToast: mocks.dismissToast,
}));
vi.mock("@/root/accountConnectionLossSuggestion.js", () => ({
  prepareAccountConnectionSwitch: mocks.prepare,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function fixture() {
  let revision = 0;
  let accept!: (view: unknown) => void;
  const snapshot = (availability: string) => ({
    revision: ++revision,
    providers: [
      {
        providerId: "account:bigmodel-team-coding-plan",
        accountState: {
          availability,
          current: true,
          connectionKey: "account/start",
        },
      },
    ],
  });
  const services = {
    providerSettingsService: {
      getView: vi.fn(async () => snapshot("available")),
      onDidChange: vi.fn((listener) => {
        accept = listener;
        return { dispose: vi.fn() };
      }),
    },
  };
  mocks.prepare.mockResolvedValue({
    selection: { kind: "individual-coding-plan" },
    apply: mocks.apply,
  });
  return { services, emit: (availability: string) => act(() => accept(snapshot(availability))) };
}
describe("根层套餐失效提示", () => {
  it("点击保存失败后提供同一目标的手动重试，不重新查询候选", async () => {
    const { services, emit } = fixture();
    mocks.apply.mockRejectedValueOnce(new Error("disk"));
    renderHook(() => useAccountConnectionLossNotification(services as never, "intent"));
    await act(async () => {});
    emit("unavailable");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    await act(async () => mocks.toast.mock.calls[0]![1]!.onAction!());
    expect(mocks.toast.mock.calls[1]![1]?.actionLabel).toBe("common.retry");
    await act(async () => mocks.toast.mock.calls[1]![1]!.onAction!());
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it("普通重新渲染不重置基线；重复不可用只提示一次，点击才提交", async () => {
    const { services, emit } = fixture();
    const refresh = vi.fn();
    const { rerender } = renderHook(() =>
      useAccountConnectionLossNotification(services as never, "intent", refresh),
    );
    await act(async () => {});
    emit("unavailable");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.apply).not.toHaveBeenCalled();
    rerender();
    emit("unavailable");
    await act(async () => {});
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(services.providerSettingsService.onDidChange).toHaveBeenCalledOnce();
    const options = mocks.toast.mock.calls[0]![1] as { onAction(): void };
    await act(async () => options.onAction());
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("切换意图立即关闭旧提示，新不可用是基线而非再次失效", async () => {
    const { services, emit } = fixture();
    const { rerender } = renderHook(
      ({ intent }) => useAccountConnectionLossNotification(services as never, intent),
      { initialProps: { intent: "old" } },
    );
    await act(async () => {});
    emit("unavailable");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    const event = mocks.prepare.mock.calls[0]![1];
    rerender({ intent: "new" });
    expect(event.isCurrent()).toBe(false);
    expect(mocks.dismissToast).toHaveBeenCalledWith(1);
    emit("unavailable");
    await act(async () => {});
    expect(mocks.toast).toHaveBeenCalledOnce();
  });
  it("备选查询失败只显示状态，不生成可点击的假目标", async () => {
    const { services, emit } = fixture();
    mocks.prepare.mockRejectedValueOnce(new Error("offline"));
    renderHook(() => useAccountConnectionLossNotification(services as never, "intent"));
    await act(async () => {});
    emit("unavailable");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.toast.mock.calls[0]![1]).toMatchObject({
      actionLabel: undefined,
      onAction: undefined,
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
