import { describe, expect, it, vi } from "vitest";

describe("desktop telemetry fetch", () => {
  it("delegates telemetry requests to Electron net.fetch", async () => {
    const { createDesktopTelemetryFetch } = await import("../src/main/desktopTelemetryFetch.js");
    const response = new Response("ok", { status: 200 });
    const electronFetch = vi.fn(async () => response);
    const telemetryFetch = createDesktopTelemetryFetch({ fetch: electronFetch });
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: "event-1" }),
    };

    const result = await telemetryFetch("https://zcode.z.ai/api/v1/event/report", init);

    expect(result).toBe(response);
    expect(electronFetch).toHaveBeenCalledWith("https://zcode.z.ai/api/v1/event/report", init);
  });
});
