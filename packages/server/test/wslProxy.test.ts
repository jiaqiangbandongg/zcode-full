import { describe, expect, it } from "vitest";
import {
  buildWslHostGatewayCommand,
  buildWslProxyPortProbeCommand,
  formatWslProxyForLog,
  isLoopbackProxyHostname,
  normalizeWslProxyUrl,
  parseWslHostGatewayOutput,
  parseWslProxyPortProbeOutput,
  replaceProxyHostname,
} from "../src/remote/wslProxy.js";

describe("WSL proxy resolution helpers", () => {
  it("识别 loopback 主机并保留 IPv6 替换格式", () => {
    expect(isLoopbackProxyHostname("localhost")).toBe(true);
    expect(isLoopbackProxyHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackProxyHostname("[::1]")).toBe(true);
    expect(isLoopbackProxyHostname("192.168.1.10")).toBe(false);
    expect(replaceProxyHostname("http://user:pass@localhost:7890/path", "2001:db8::1")).toBe(
      "http://user:pass@[2001:db8::1]:7890/path",
    );
  });

  it("规范化裸代理地址并解析探测结果", () => {
    expect(normalizeWslProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890/");
    expect(parseWslProxyPortProbeOutput("reachable\n")).toBe(true);
    expect(parseWslProxyPortProbeOutput("unreachable")).toBe(false);
    expect(parseWslProxyPortProbeOutput("unexpected")).toBeUndefined();
    expect(buildWslProxyPortProbeCommand("http://127.0.0.1:7890")).toContain(
      "/dev/tcp/127.0.0.1/7890",
    );
  });

  it("只从网关输出中接受合法 IP，并在日志中隐藏凭据和路径", () => {
    expect(parseWslHostGatewayOutput("nameserver 172.21.240.1\n")).toBe("172.21.240.1");
    expect(parseWslHostGatewayOutput("route=127.0.0.53")).toBeNull();
    expect(parseWslHostGatewayOutput("8.8.8.8")).toBeNull();
    expect(parseWslHostGatewayOutput("route=127.0.0.53 resolv=172.21.240.1")).toBe("172.21.240.1");
    expect(parseWslHostGatewayOutput("resolv=127.0.0.53 resolv=8.8.8.8 resolv=172.21.240.1")).toBe(
      "172.21.240.1",
    );
    const command = buildWslHostGatewayCommand();
    expect(command.indexOf("ip route show default")).toBeLessThan(
      command.indexOf("/etc/resolv.conf"),
    );
    expect(command).toContain('$1=="default" && $2=="via"');
    expect(parseWslHostGatewayOutput("gateway unavailable")).toBeNull();
    expect(formatWslProxyForLog("http://user:secret@proxy.example.com:7890/private")).toBe(
      "http://proxy.example.com:7890",
    );
  });
});
