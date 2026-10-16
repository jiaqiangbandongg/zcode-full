import weekendPlanHeroUrl from "@/assets/cloud-content/weekend-plan-hero.html?url";
import weekendPlanResultDialogFixture from "@/components/cloud-content-dialog/mocks/weekendPlanResultDialog.zh-CN.json" with { type: "json" };
import type { CloudContentDialogPayload } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

// 这是受控内容模板；HTTP mock 注入真实 ZIP 元数据后才是 wire payload。
const weekendPlanResultDialogMockResponse = weekendPlanResultDialogFixture;

export interface WeekendPlanResultDialogMockInput {
  locale: "zh-CN" | "en-US";
  planName: string;
  amountLabel: string;
  benefits: string[];
  endsAtLabel: string;
  title: string;
  description: string;
  descriptionFormat?: CloudContentDialogPayload["dialog"]["description"]["format"];
  replayLabel: string;
  confirmLabel: string;
  shareLabel: string;
  shareText: string;
  endsAtPrefix?: string;
}

export function createWeekendPlanResultDialogMock(
  input: WeekendPlanResultDialogMockInput,
): CloudContentDialogPayload {
  const amountSeparatorIndex = input.amountLabel.lastIndexOf(" ");
  const amountValue =
    amountSeparatorIndex > 0 ? input.amountLabel.slice(0, amountSeparatorIndex) : input.amountLabel;
  const amountUnit =
    amountSeparatorIndex > 0 ? input.amountLabel.slice(amountSeparatorIndex + 1) : "";

  return {
    schemaVersion: 1,
    id: weekendPlanResultDialogMockResponse.id,
    revision: weekendPlanResultDialogMockResponse.revision,
    kind: "campaign",
    locale: input.locale,
    dialog: {
      hero: {
        type: "interactive_bundle",
        runtime: "zcode-hero-sandbox-v1",
        resolvedUrl: weekendPlanHeroUrl,
        viewport: { aspectRatio: "4:3" },
        data: {
          planName: input.planName,
          amountLabel: input.amountLabel,
          amountValue,
          amountUnit,
          benefits: input.benefits,
          endsAtLabel: input.endsAtLabel,
          endsAtPrefix:
            input.endsAtPrefix ?? (input.locale === "zh-CN" ? "有效期至" : "Valid until"),
          replayLabel: input.replayLabel,
        },
        events:
          weekendPlanResultDialogMockResponse.dialog.hero.type === "interactive_bundle"
            ? weekendPlanResultDialogMockResponse.dialog.hero.events
            : { replay: "replay" },
      },
      title: input.title,
      description: { format: input.descriptionFormat ?? "plain_text", text: input.description },
      buttons: [
        {
          id: weekendPlanResultDialogMockResponse.dialog.buttons[0]!.id,
          label: input.confirmLabel,
          variant: "primary",
          actionId: weekendPlanResultDialogMockResponse.dialog.buttons[0]!.actionId,
        },
        {
          id: weekendPlanResultDialogMockResponse.dialog.buttons[1]!.id,
          label: input.shareLabel,
          variant: "secondary",
          actionId: weekendPlanResultDialogMockResponse.dialog.buttons[1]!.actionId,
        },
      ],
    },
    actions: {
      "open-model-settings": { type: "navigate", destination: "model_settings" },
      "copy-share": {
        type: "copy_text",
        text: input.shareText,
      },
    },
  };
}
