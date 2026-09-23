// 满血版新增的斜杠命令帮助，由 zcode-slash-command-help.ts 追加在上游命令之后。
export const FORK_SLASH_COMMAND_HELP_ENTRIES = [
  {
    details: [
      "Shows current Git auto-backup status and configuration.",
      "Use configure to set up Alibaba Cloud OSS credentials interactively.",
      "Use enable or disable to toggle automatic backups.",
      "Use run to trigger an immediate backup of the current workspace.",
    ],
    name: "backup",
    summary: "Manage Git auto-backup to Alibaba Cloud OSS.",
    usage: "/backup [status|configure|enable|disable|run]",
  },
] as const;
