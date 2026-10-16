import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT,
  flushInterfaceNetworkStats,
  ingestArmsApiEvent,
  normalizeHttpInterface,
  recordNetworkObservation,
  resetNetworkTelemetryAggregator,
} from "../src/main/networkTelemetryAggregator.js";

describe("networkTelemetryAggregator", () => {
  beforeEach(() => {
    resetNetworkTelemetryAggregator();
  });

  it("aggregates rpc success and failure by interface", () => {
    recordNetworkObservation({
      transport: "rpc",
      interface: "file.read",
      durationMs: 10,
      ok: true,
    });
    recordNetworkObservation({
      transport: "rpc",
      interface: "file.read",
      durationMs: 20,
      ok: false,
      errorKind: "timeout",
    });

    const stats = flushInterfaceNetworkStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]?.interface).toBe("file.read");
    expect(stats[0]?.requestTotal).toBe(2);
    expect(stats[0]?.successCount).toBe(1);
    expect(stats[0]?.failCount).toBe(1);
    expect(stats[0]?.errorCounts.timeout).toBe(1);
  });

  it("ingestArmsApiEvent maps dns/ttfb phases", () => {
    ingestArmsApiEvent({
      event_type: "api",
      name: "https://api.example.com/v1/tasks",
      duration: 120,
      success: 1,
      dns_duration: 5,
      connect_duration: 10,
      ssl_duration: 15,
      first_byte_duration: 40,
      download_duration: 50,
      times: 2,
    });

    const stats = flushInterfaceNetworkStats();
    expect(stats[0]?.transport).toBe("http");
    expect(stats[0]?.interface).toBe(normalizeHttpInterface("https://api.example.com/v1/tasks"));
    expect(stats[0]?.retryCount).toBe(1);
    expect(stats[0]?.dns.mean).toBe(5);
    expect(stats[0]?.ttfb.mean).toBe(40);
  });

  it("模板化 HTTP 动态路径并丢弃本地绝对路径", () => {
    expect(
      normalizeHttpInterface(
        "https://api.example.com/v1/tasks/123456/550e8400-e29b-41d4-a716-446655440000?token=secret",
      ),
    ).toBe("api.example.com/v1/tasks/:id/:id");
    expect(normalizeHttpInterface("file:///Users/alice/private.txt")).toBe("local_file");
    expect(normalizeHttpInterface("C:\\Users\\alice\\private.txt")).toBe("local_file");
    expect(normalizeHttpInterface("/opt/acme/private.txt")).toBe("local_file");
    expect(normalizeHttpInterface("/root/private.txt")).toBe("local_file");
    expect(normalizeHttpInterface("https://api.example.com/users/alice%40example.com")).toBe(
      "api.example.com/users/:id",
    );
    expect(normalizeHttpInterface("https://api.example.com/projects/customer-secret")).toBe(
      "api.example.com/projects/:id",
    );
    expect(normalizeHttpInterface("https://api.example.com/v123456/users")).toBe(
      "api.example.com/:id/users",
    );
  });

  it("未知 errorKind 归入 other，不生成动态属性键", () => {
    recordNetworkObservation({
      transport: "rpc",
      interface: "file.read",
      durationMs: 10,
      ok: false,
      errorKind: "customer-secret-error-message",
    });

    expect(flushInterfaceNetworkStats()[0]?.errorCounts).toEqual({ other: 1 });
  });

  it("多种错误计数相同时按固定枚举顺序选择主错误", () => {
    recordNetworkObservation({
      transport: "http",
      interface: "https://api.example.com/v1/tasks",
      durationMs: 20,
      ok: false,
      errorKind: "server_error",
    });
    recordNetworkObservation({
      transport: "http",
      interface: "https://api.example.com/v1/tasks",
      durationMs: 10,
      ok: false,
      errorKind: "timeout",
    });

    const stats = flushInterfaceNetworkStats();
    expect(stats[0]?.primaryErrorKind).toBe("timeout");
    expect(stats[0]?.primaryErrorCount).toBe(1);
  });

  it("每种 transport 的接口 bucket 有硬上限，溢出汇总到 other", () => {
    for (let index = 0; index < MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT + 20; index += 1) {
      recordNetworkObservation({
        transport: "rpc",
        interface: `channel.command_${index}`,
        durationMs: index,
        ok: true,
      });
    }

    const stats = flushInterfaceNetworkStats(MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT + 20);
    expect(stats.length).toBeLessThanOrEqual(MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT);
    expect(stats.find((item) => item.interface === "other")?.requestTotal).toBeGreaterThan(1);
  });
});
