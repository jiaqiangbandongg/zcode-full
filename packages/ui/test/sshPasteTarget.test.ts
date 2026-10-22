import { describe, expect, it } from "vitest";
import { parseSshPasteTarget } from "@/lib/remoteConnectionWizard.js";

describe("parseSshPasteTarget", () => {
  it.each([
    ["root@10.0.0.5", { host: "10.0.0.5", username: "root" }],
    ["root@10.0.0.5:2222", { host: "10.0.0.5", username: "root", port: "2222" }],
    ["dev.example.com:2200", { host: "dev.example.com", port: "2200" }],
    ["  deploy@staging.example.com  ", { host: "staging.example.com", username: "deploy" }],
    ["ssh root@10.0.0.5 -p 2222", { host: "10.0.0.5", username: "root", port: "2222" }],
    ["ssh -p 2222 root@10.0.0.5", { host: "10.0.0.5", username: "root", port: "2222" }],
    ["ssh root@10.0.0.5", { host: "10.0.0.5", username: "root" }],
    ["ssh dev.example.com", { host: "dev.example.com" }],
    ["root@[::1]:2222", { host: "::1", username: "root", port: "2222" }],
    ["ssh root@[fe80::1] -p 22", { host: "fe80::1", username: "root", port: "22" }],
  ])("拆分 %s", (text, expected) => {
    expect(parseSshPasteTarget(text)).toEqual(expected);
  });

  it.each([
    // 纯主机名没有可拆分信息，交给浏览器原样粘贴。
    "10.0.0.5",
    "dev.example.com",
    "",
    "hello world",
    "root@10.0.0.5:0",
    "root@10.0.0.5:65536",
    "root@10.0.0.5:22a",
    "ssh -i ~/.ssh/id root@10.0.0.5",
    "ssh root@10.0.0.5 -p",
    "ssh root@a root@b",
    "a@b@c",
    "https://example.com:8080",
    // 用户名不含 ":" 或 "/"：SSH URI 和 user:password@host 不拆分，原样粘贴。
    "ssh://root@10.0.0.5:22",
    "root:secret@10.0.0.5",
  ])("不匹配时返回 null：%s", (text) => {
    expect(parseSshPasteTarget(text)).toBeNull();
  });
});
