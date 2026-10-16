// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOptimisticReorder } from "@/settings/model-provider-section/useOptimisticReorder.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ReorderHarness({ persist }: { persist: (ids: readonly string[]) => Promise<void> }) {
  const [authoritativeIds, setAuthoritativeIds] = useState<readonly string[]>(["a", "b", "c"]);
  const reorder = useOptimisticReorder({ authoritativeIds, persist });

  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "order" }, reorder.renderedIds.join(",")),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => void reorder.commit(["c", "a", "b"]).catch(() => undefined),
      },
      "reorder-once",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => void reorder.commit(["b", "c", "a"]).catch(() => undefined),
      },
      "reorder-twice",
    ),
    createElement(
      "button",
      { type: "button", onClick: () => setAuthoritativeIds(["c", "a", "b"]) },
      "confirm-first",
    ),
    createElement(
      "button",
      { type: "button", onClick: () => setAuthoritativeIds(["a", "b", "c"]) },
      "repeat-old-view",
    ),
    createElement(
      "button",
      { type: "button", onClick: () => setAuthoritativeIds(["b", "c", "a"]) },
      "confirm-second",
    ),
    createElement(
      "button",
      { type: "button", onClick: () => setAuthoritativeIds(["a", "b", "c", "d"]) },
      "change-members",
    ),
  );
}

afterEach(cleanup);

describe("useOptimisticReorder", () => {
  it("保存完成前立即按目标顺序渲染，正式 View 对齐后保持稳定", async () => {
    const save = deferred<void>();
    render(createElement(ReorderHarness, { persist: () => save.promise }));

    fireEvent.click(screen.getByRole("button", { name: "reorder-once" }));

    expect(screen.getByTestId("order").textContent).toBe("c,a,b");
    expect(save.promise).toBeInstanceOf(Promise);

    fireEvent.click(screen.getByRole("button", { name: "confirm-first" }));
    save.resolve();
    await save.promise;

    expect(screen.getByTestId("order").textContent).toBe("c,a,b");
  });

  it("保存确认前收到成员相同的旧 View 时继续保留用户目标顺序", () => {
    const save = deferred<void>();
    render(createElement(ReorderHarness, { persist: () => save.promise }));

    fireEvent.click(screen.getByRole("button", { name: "reorder-once" }));
    fireEvent.click(screen.getByRole("button", { name: "repeat-old-view" }));

    expect(screen.getByTestId("order").textContent).toBe("c,a,b");
  });

  it("保存失败时回滚到正式 View", async () => {
    const save = deferred<void>();
    render(createElement(ReorderHarness, { persist: () => save.promise }));

    fireEvent.click(screen.getByRole("button", { name: "reorder-once" }));
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");

    save.reject(new Error("save failed"));
    await vi.waitFor(() => expect(screen.getByTestId("order").textContent).toBe("a,b,c"));
  });

  it("正式 View 的模型成员变化时退出旧 pending 顺序", () => {
    const save = deferred<void>();
    render(createElement(ReorderHarness, { persist: () => save.promise }));

    fireEvent.click(screen.getByRole("button", { name: "reorder-once" }));
    fireEvent.click(screen.getByRole("button", { name: "change-members" }));

    expect(screen.getByTestId("order").textContent).toBe("a,b,c,d");
  });

  it("连续排序串行保存，旧结果不会覆盖较新的乐观顺序", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const persist = vi
      .fn<(ids: readonly string[]) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(createElement(ReorderHarness, { persist }));

    fireEvent.click(screen.getByRole("button", { name: "reorder-once" }));
    fireEvent.click(screen.getByRole("button", { name: "reorder-twice" }));

    expect(screen.getByTestId("order").textContent).toBe("b,c,a");
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "confirm-first" }));
    first.resolve();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("order").textContent).toBe("b,c,a");

    fireEvent.click(screen.getByRole("button", { name: "confirm-second" }));
    second.resolve();
    await second.promise;
    expect(screen.getByTestId("order").textContent).toBe("b,c,a");
  });

  it("切换持久化 Owner 时丢弃旧 Environment 的 pending 顺序", () => {
    const firstSave = deferred<void>();
    const firstPersist = () => firstSave.promise;
    const { rerender } = render(
      createElement(ReorderHarness, {
        persist: firstPersist,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "reorder-once" }));
    expect(screen.getByTestId("order").textContent).toBe("c,a,b");

    rerender(createElement(ReorderHarness, { persist: async () => undefined }));
    expect(screen.getByTestId("order").textContent).toBe("a,b,c");
  });
});
