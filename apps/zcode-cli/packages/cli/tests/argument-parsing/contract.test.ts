import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractDisallowedToolsArgs,
  isProtocolServerInvocation,
  parseGlobalArgs,
} from "../../src/arguments.js";
import type { CliArgumentsContract } from "../../src/argument-parsing/contract.js";

const contract: CliArgumentsContract = {
  extractDisallowedToolsArgs,
  isProtocolServerInvocation,
  parseGlobalArgs,
};

test("工具禁用规则与 ToolSearch 模式可同时解析且不修改原参数", () => {
  const argv = [
    "--disallowedTools",
    "web_search,Bash(git status)",
    "--toolsearch-mode",
    "local",
    "--prompt",
    "hello",
  ];
  const original = [...argv];
  const extracted = contract.extractDisallowedToolsArgs(argv);
  assert.deepEqual(extracted.toolDisallowlist, ["WebSearch", "Bash(git status)"]);
  assert.equal(contract.parseGlobalArgs(extracted.args).values["toolsearch-mode"], "local");
  assert.equal(contract.parseGlobalArgs(extracted.args).values.prompt, "hello");
  assert.deepEqual(argv, original);
});

test("全局参数保持严格校验且禁用规则不能缺失", () => {
  assert.throws(() => contract.parseGlobalArgs(["--unknown-argument"]));
  assert.throws(() => contract.extractDisallowedToolsArgs(["--disallowedTools"]));
});

test("协议入口识别与普通 prompt 调用保持分离", () => {
  assert.equal(contract.isProtocolServerInvocation(["app-server"]), true);
  assert.equal(contract.isProtocolServerInvocation(["agent-server"]), true);
  assert.equal(contract.isProtocolServerInvocation(["--prompt", "app-server"]), false);
});
