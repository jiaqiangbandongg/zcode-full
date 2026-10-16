import { describe, expect, it, vi } from "vitest";
import {
  fetchBotProvider,
  fetchBotProviderJson,
} from "#src/bots/providers/providerRequest.js";

describe("fetchBotProvider", () => {
  it("aborts a provider request when its deadline expires", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBotProvider("https://provider.test/callback", {}, 25);
    const rejection = expect(request).rejects.toThrow("timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    vi.useRealTimers();
  });

  it("forwards an external abort and removes its listener after completion", async () => {
    const external = new AbortController();
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("external abort")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBotProvider(
      "https://provider.test/callback",
      { signal: external.signal },
      1_000,
    );
    external.abort();

    await expect(request).rejects.toThrow("external abort");
  });

  it("keeps the deadline active while consuming a stalled JSON body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBotProviderJson("https://provider.test/callback", {}, 25);
    const rejection = expect(request).rejects.toThrow("timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    vi.useRealTimers();
  });

  it("keeps the deadline active after headers while consuming a stalled body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchBotProvider("https://provider.test/callback", {}, 25);
    const rejection = expect(request).rejects.toThrow("timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    vi.useRealTimers();
  });
});
