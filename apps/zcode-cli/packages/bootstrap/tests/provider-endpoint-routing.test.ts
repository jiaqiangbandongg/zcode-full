import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { resolveProcessProviderEndpointRoutingPort } from "../src/provider-endpoint-routing.js";

describe("resolveProcessProviderEndpointRoutingPort", () => {
  it("shares one process snapshot owner for the same endpoint and network policy", () => {
    const env = {
      ZCODE_ENV: "test",
      ZCODE_TEST_BASE_URL: "https://routing-config.example.test",
    };
    const network = {
      httpProxy: "http://proxy.example.test:8080",
      noProxy: "routing-config.example.test",
    };

    const first = resolveProcessProviderEndpointRoutingPort({
      appVersion: "1.2.3",
      env,
      logger,
      network,
    });
    const second = resolveProcessProviderEndpointRoutingPort({
      appVersion: "9.9.9",
      env: { ...env },
      logger,
      network: { ...network },
    });

    expect(second).toBe(first);
  });

  it("isolates ports when the endpoint origin changes", () => {
    const create = (origin: string) =>
      resolveProcessProviderEndpointRoutingPort({
        env: { ZCODE_ENV: "production", ZCODE_BASE_URL: origin },
        logger,
        network: {},
      });
    expect(create("https://first.example.test")).not.toBe(create("https://second.example.test"));
  });

  it("isolates snapshots when the network policy changes", () => {
    const env = {
      ZCODE_ENV: "test",
      ZCODE_TEST_BASE_URL: "https://routing-config-network.example.test",
    };
    const direct = resolveProcessProviderEndpointRoutingPort({
      appVersion: "1.2.3",
      env,
      logger,
      network: {},
    });
    const proxied = resolveProcessProviderEndpointRoutingPort({
      appVersion: "1.2.3",
      env,
      logger,
      network: { httpProxy: "http://proxy.example.test:8080" },
    });

    expect(proxied).not.toBe(direct);
  });
});

const logger: Logger = {
  child: () => logger,
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};
