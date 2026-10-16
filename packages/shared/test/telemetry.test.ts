import { describe, expect, it } from "vitest";
import { resolveSafeTelemetryHostname } from "../src/telemetry.js";

describe("resolveSafeTelemetryHostname", () => {
  it("只从 HTTP(S) URL 提取小写 hostname", () => {
    expect(
      resolveSafeTelemetryHostname("https://user:secret@API.Example.COM:8443/private?q=jwt"),
    ).toBe("api.example.com");
    expect(resolveSafeTelemetryHostname("http://127.0.0.1:64411")).toBe("127.0.0.1");
  });

  it.each(["", "api.example.com", "file:///private/path", "not a url"])(
    "拒绝非 URL 或非 HTTP(S) 值：%s",
    (value) => {
      expect(resolveSafeTelemetryHostname(value)).toBe("");
    },
  );
});
