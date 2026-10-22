/**
 * channel-reply-tool 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const channelReplyToolModule = {
  id: "channel-reply-tool",
  requires: ["shared", "zcode-cli"],
  provides: ["channel-reply-tool"],
  publicEntrypoints: ["../handlers/reply-to-channel.ts", "contract.ts"],
} as const;
