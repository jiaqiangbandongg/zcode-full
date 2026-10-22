import { describe, expect, it } from "vitest";
import type { BotConfig } from "@zcode/shared";
import { ALL_BOT_WORKSPACES } from "@zcode/shared";
import {
  BOT_REPLY_GRANULARITIES,
  getBotReplyGranularitiesForProvider,
  getBotReplyGranularityEntryForProvider,
  resolveBotProviderEntry,
} from "../src/botsUi.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("BotsDialog config", () => {
  it("keeps reply granularity labels localized", () => {
    for (const granularity of BOT_REPLY_GRANULARITIES) {
      expect(enUS[granularity.labelId]).toBeTruthy();
      expect(zhCN[granularity.labelId]).toBeTruthy();
      expect(enUS[granularity.descriptionId]).toBeTruthy();
      expect(zhCN[granularity.descriptionId]).toBeTruthy();
    }
  });

  it("limits Feishu and Lark reply granularity to streaming cards", () => {
    expect(getBotReplyGranularitiesForProvider("feishu").map((item) => item.id)).toEqual([
      "streaming_card",
    ]);
    expect(getBotReplyGranularitiesForProvider("lark").map((item) => item.id)).toEqual([
      "streaming_card",
    ]);
    expect(getBotReplyGranularitiesForProvider("telegram").map((item) => item.id)).toEqual([
      "assistant_changes",
      "assistant_toolcalls_changes",
      "summary_changes",
    ]);
    expect(getBotReplyGranularityEntryForProvider("feishu", "assistant_changes").id).toBe(
      "streaming_card",
    );
    expect(getBotReplyGranularityEntryForProvider("telegram", "streaming_card").id).toBe(
      "assistant_changes",
    );
  });

  it("resolves remote-control bot entry to the first existing provider bot", () => {
    const bots: BotConfig[] = [
      createBot("feishu-later", "feishu"),
      createBot("telegram-first", "telegram"),
      createBot("telegram-second", "telegram"),
    ];

    expect(resolveBotProviderEntry(bots, "telegram")).toEqual({
      mode: "select",
      botId: "telegram-first",
    });
  });

  it("resolves remote-control bot entry to provider creation when no bot exists", () => {
    expect(resolveBotProviderEntry([createBot("weixin-one", "weixin")], "feishu")).toEqual({
      mode: "create",
      provider: "feishu",
    });
  });
});

function createBot(id: string, provider: BotConfig["provider"]): BotConfig {
  return {
    id,
    name: "",
    provider,
    enabled: true,
    allowedWorkspaces: [ALL_BOT_WORKSPACES],
    allowedCommands: {
      readFile: "always",
      writeFile: "ask",
      runCommand: "ask",
    },
    currentOptions: {},
    replyMode: "assistant_changes",
  };
}
