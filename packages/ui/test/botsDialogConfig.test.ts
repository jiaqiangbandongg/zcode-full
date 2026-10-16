import { describe, expect, it } from "vitest";
import type { BotConfig } from "@zcode/shared";
import { ALL_BOT_WORKSPACES } from "@zcode/shared";
import {
  BOT_PROVIDERS,
  BOT_REPLY_GRANULARITIES,
  getBotReplyGranularitiesForProvider,
  getBotReplyGranularityEntryForProvider,
  getBotProviderRegionTagLabelId,
  resolveBotProviderEntry,
} from "../src/botsUi.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("BotsDialog config", () => {
  it("keeps reply granularity labels localized", () => {
    expect(BOT_REPLY_GRANULARITIES.map((item) => item.id)).toEqual([
      "assistant_changes",
      "assistant_toolcalls_changes",
      "summary_changes",
      "streaming_card",
    ]);

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
    expect(
      getBotReplyGranularityEntryForProvider("feishu", "assistant_changes").id,
    ).toBe("streaming_card");
    expect(
      getBotReplyGranularityEntryForProvider("telegram", "streaming_card").id,
    ).toBe("assistant_changes");
  });

  it("keeps bind state actions localized", () => {
    for (const key of [
      "bots.bind",
      "bots.unbind",
      "bots.unbindSuccess",
      "bots.unbindFailed",
      "bots.copyBindCommand",
      "bots.bindCommandGuide",
      "bots.bindCommandStep.copy",
      "bots.bindCommandStep.openChat",
      "bots.bindCommandStep.send",
      "bots.bindCommandCopied",
    ]) {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
    }
  });

  it("shows Lark as a supported new bot entry and keeps DingTalk coming soon", () => {
    expect(BOT_PROVIDERS.find((provider) => provider.id === "lark")).toEqual({
      id: "lark",
      label: "Lark",
      implemented: true,
    });
    expect(BOT_PROVIDERS.find((provider) => provider.id === "dingding")).toEqual(
      {
        id: "dingding",
        label: "DingTalk",
        implemented: false,
      },
    );
    expect(enUS["bots.channel.dingding"]).toBeTruthy();
    expect(zhCN["bots.channel.dingding"]).toBeTruthy();
    expect(enUS["bots.newBot.providerDescription.lark"]).toBeTruthy();
    expect(zhCN["bots.newBot.providerDescription.lark"]).toBeTruthy();
    expect(enUS["bots.newBot.providerDescription.dingding"]).toBeTruthy();
    expect(zhCN["bots.newBot.providerDescription.dingding"]).toBeTruthy();
  });

  it("uses welcome screen region tags for Feishu and Lark bot entries", () => {
    expect(getBotProviderRegionTagLabelId("lark")).toBe(
      "login.oauth.regionTag.zai",
    );
    expect(getBotProviderRegionTagLabelId("feishu")).toBe(
      "login.oauth.regionTag.bigmodel",
    );
    expect(getBotProviderRegionTagLabelId("telegram")).toBeNull();
    expect(enUS["login.oauth.regionTag.zai"]).toBe("Global");
    expect(zhCN["login.oauth.regionTag.zai"]).toBe("全球");
    expect(enUS["login.oauth.regionTag.bigmodel"]).toBe("CN");
    expect(zhCN["login.oauth.regionTag.bigmodel"]).toBe("中国");
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
    expect(
      resolveBotProviderEntry([createBot("weixin-one", "weixin")], "feishu"),
    ).toEqual({
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
