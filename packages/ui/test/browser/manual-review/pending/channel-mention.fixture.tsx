import { createRoot } from "react-dom/client";
import { channelContentText, type ChannelContentPart } from "@zcode/shared";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { BotTopicPreparationList } from "@/v4/BotTopicPreparation.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";
const theme = new URLSearchParams(location.search).get("theme");
document.documentElement.className =
  theme === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const parts: ChannelContentPart[] = [
  { type: "text", text: "帮我 " },
  {
    type: "channelMention",
    refId: "m1",
    name: "Ryan Bot",
    targetId: "ou_target",
    channel: "feishu",
    idType: "open_id",
    entityType: "unknown",
  },
  { type: "text", text: " 确认进度" },
];
const text = channelContentText(parts);
const source = {
  provider: "feishu",
  botId: "bot",
  senderId: "ou_sender",
  senderName: "Alice",
  chatId: "oc_group",
  messageId: "om_input",
  contentParts: parts,
};
const queue = {
  items: [
    {
      queueItemId: "q1",
      dispatch: { state: "queued" },
      text,
      attachments: [],
      botGroupSource: source,
    },
  ],
  revision: 1,
} as unknown as QueueState;
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <main className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <ConversationUserInputBubble text={text} contentParts={parts} rowId="native" />
          <BotTopicPreparationList
            provider="feishu"
            items={[
              {
                messageId: "preparing",
                senderName: "Alice",
                text,
                contentParts: parts,
                status: "preparing",
              },
            ]}
            acceptedRows={[]}
          />
          <ConversationQueuePanel queue={queue} />
          <div data-testid="typed">
            <ConversationUserInputBubble text={text} rowId="typed" />
          </div>
        </div>
      </main>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
