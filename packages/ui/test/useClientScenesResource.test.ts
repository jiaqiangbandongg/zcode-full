// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";
import type {
  ClientSceneConfig,
  ClientScenesResponse,
  IClientScenesService,
} from "@zcode/services";
import {
  CLIENT_SCENES_DEDUPING_INTERVAL_MS,
  isClientScenesBusinessError,
  useClientScenesResource,
} from "@/hooks/useClientScenesResource.js";

function response(id: string): ClientScenesResponse {
  return {
    code: 0,
    msg: "success",
    data: [
      {
        namespace: "zcode",
        scene: id,
        options: {},
        created_at: 0,
        updated_at: 0,
      } satisfies ClientSceneConfig,
    ],
  };
}

function service(list: () => Promise<ClientScenesResponse>): IClientScenesService {
  return { list };
}

function createWrapper() {
  const cache = new Map();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      SWRConfig,
      {
        value: {
          provider: () => cache,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        },
      },
      children,
    );
  };
}

describe("useClientScenesResource", () => {
  it("uses a ten-minute cache deduplication window", () => {
    expect(CLIENT_SCENES_DEDUPING_INTERVAL_MS).toBe(10 * 60 * 1000);
  });

  it("deduplicates concurrent consumers that share one service authority", async () => {
    let resolveList!: (value: ClientScenesResponse) => void;
    const list = vi.fn(
      () =>
        new Promise<ClientScenesResponse>((resolve) => {
          resolveList = resolve;
        }),
    );
    const clientScenesService = service(list);
    const wrapper = createWrapper();
    const first = renderHook(() => useClientScenesResource(clientScenesService), {
      wrapper,
    });
    const second = renderHook(() => useClientScenesResource(clientScenesService), {
      wrapper,
    });

    expect(first.result.current.loading).toBe(true);
    expect(second.result.current.loading).toBe(true);
    expect(list).toHaveBeenCalledOnce();

    await act(async () => {
      resolveList(response("shared"));
      await Promise.resolve();
    });

    expect(first.result.current.scenes[0]?.scene).toBe("shared");
    expect(second.result.current.scenes[0]?.scene).toBe("shared");
    expect(list).toHaveBeenCalledOnce();
  });

  it("returns a warm cached result immediately without a second request", async () => {
    const list = vi.fn().mockResolvedValue(response("cached"));
    const clientScenesService = service(list);
    const wrapper = createWrapper();
    const first = renderHook(() => useClientScenesResource(clientScenesService), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() => useClientScenesResource(clientScenesService), {
      wrapper,
    });

    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.scenes[0]?.scene).toBe("cached");
    expect(list).toHaveBeenCalledOnce();
  });

  it("preserves last-known-good data when a background revalidation fails", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(response("last-known-good"))
      .mockRejectedValueOnce(new Error("offline"));
    const clientScenesService = service(list);
    const { result } = renderHook(() => useClientScenesResource(clientScenesService), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      try {
        await result.current.revalidate();
      } catch {
        // SWR may surface a manual mutate error; state must still retain cached data.
      }
    });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    expect(result.current.loading).toBe(false);
    expect(result.current.scenes[0]?.scene).toBe("last-known-good");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("treats a nonzero business response as an error without caching its data", async () => {
    const clientScenesService = service(async () => ({
      code: 5001,
      msg: "scene unavailable",
      data: response("must-not-render").data,
    }));
    const { result } = renderHook(() => useClientScenesResource(clientScenesService), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scenes).toEqual([]);
    expect(isClientScenesBusinessError(result.current.error)).toBe(true);
    expect(result.current.error).toMatchObject({
      code: 5001,
      responseMessage: "scene unavailable",
    });
  });

  it("does not request scenes while the service authority is not ready", () => {
    const list = vi.fn().mockResolvedValue(response("unused"));
    const { result } = renderHook(
      () => useClientScenesResource(service(list), { enabled: false }),
      { wrapper: createWrapper() },
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.scenes).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });
});
