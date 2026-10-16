# Remote Control Bot Channel Entry

远程控制弹窗现在同时承载两类入口：

- 手机 Web：继续使用当前 Web remote control session 的连接状态、二维码和复制链接。
- Bot Channel：提供微信、飞书、Telegram 三个入口，面向长期或常用通讯工具里的远程控制。

Bot Channel card 的点击逻辑统一打开 `packages/ui/src/BotsDialog.tsx`：

- 如果已有对应渠道的机器人，选中该渠道的第一个机器人。
- 如果没有对应渠道的机器人，直接创建该渠道的新机器人，并进入该机器人的配置流程。

入口选择逻辑集中在 `resolveBotProviderEntry()`，避免远程控制弹窗直接理解 BotsDialog 内部状态结构。
