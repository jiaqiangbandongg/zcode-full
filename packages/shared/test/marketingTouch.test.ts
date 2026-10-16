import { describe, expect, it } from "vitest";
import {
  parseMarketingTouchResponse,
  marketingActionSchema,
  marketingPopupSchema,
} from "../src/marketingTouch.js";

const text = { format: "plaintext", content: "Hello", style: {} };
// 服务端未约定 Lottie；避免将通用播放器能力误扩展为营销接口字段。
it("rejects uncontracted Lottie deliveries without discarding valid siblings", () => {
  const hero = { type: "lottie", lottie: { src: asset } };
  expect(marketingPopupSchema.safeParse({ ...popup, hero }).success).toBe(false);
  const result = parseMarketingTouchResponse(
    envelope([
      {
        campaign_id: "unsupported",
        resource_position: "banner",
        priority: 1,
        banner: { background: hero, buttons: [] },
      },
      { campaign_id: "valid", resource_position: "popup", priority: 1, popup },
    ]),
  );
  expect(result.rejectedCount).toBe(1);
  expect(result.deliveries.map((delivery) => delivery.campaign_id)).toEqual(["valid"]);
});
const asset = { src: "https://cdn.example.com/banner.png", sha256: "a".repeat(64) };
const button = (type = "close") => ({ text, action: { type, args: {} } });
const popup = { title: text, description: text, buttons: [button()] };
const envelope = (deliveries: unknown[]) => ({
  code: 0,
  data: { server_time: 1, language: "en-US", deliveries },
});

describe("marketing touch wire contract", () => {
  it("accepts video backgrounds through the same VisualBody as popup heroes", () => {
    const background = { type: "video", video: { src: asset, fallback: asset } };
    const result = parseMarketingTouchResponse(
      envelope([
        {
          campaign_id: "video",
          resource_position: "banner",
          priority: 1,
          banner: { background, buttons: [button()] },
        },
      ]),
    );
    expect(result.rejectedCount).toBe(0);
    expect(result.deliveries).toHaveLength(1);
  });
  const bannerDelivery = (format: unknown, content = "") => ({
    campaign_id: "banner",
    resource_position: "banner",
    priority: 1,
    banner: {
      background: { type: "image", image: { default: asset } },
      buttons: [
        { text: { format, content }, action: { type: "close" } },
        {
          text: { format, content },
          action: { type: "claim_zcode_plan", args: { plan_id: "plan" } },
        },
      ],
      success_popup: popup,
    },
  });
  it.each(["", "领取"])("accepts empty banner format with content %j", (content) => {
    const result = parseMarketingTouchResponse(envelope([bannerDelivery("", content)]));
    expect(result.rejectedCount).toBe(0);
    const delivery = result.deliveries[0];
    expect(delivery?.resource_position).toBe("banner");
    if (delivery?.resource_position !== "banner") throw new Error("Missing banner");
    expect(delivery.banner.buttons.map((b) => b.text)).toEqual([
      { format: "plaintext", content },
      { format: "plaintext", content },
    ]);
  });
  it.each([undefined, null, "unknown"])("rejects invalid banner format %j", (format) => {
    expect(parseMarketingTouchResponse(envelope([bannerDelivery(format)])).rejectedCount).toBe(1);
  });
  it("accepts banner bundles with args and fallback, but rejects unsafe entry paths", () => {
    const delivery = bannerDelivery("");
    const background = {
      type: "bundle",
      bundle: {
        bundle: { ...asset, src: "https://cdn.example.com/banner.zip" },
        entry: "index.html",
        fallback: asset,
      },
      args: { heading: "Weekend" },
    };
    const raw = { ...delivery, banner: { ...delivery.banner, background } };
    expect(parseMarketingTouchResponse(envelope([raw])).rejectedCount).toBe(0);
    background.bundle.entry = "../index.html";
    expect(parseMarketingTouchResponse(envelope([raw])).rejectedCount).toBe(1);
  });
  it.each(["title", "description", "buttons"])(
    "still rejects empty popup %s format in both positions",
    (field) => {
      const emptyText = { ...text, format: "" };
      const invalidPopup = {
        ...popup,
        [field]: field === "buttons" ? [{ ...button(), text: emptyText }] : emptyText,
      };
      const delivery = bannerDelivery("");
      delivery.banner.success_popup = invalidPopup;
      const result = parseMarketingTouchResponse(
        envelope([
          delivery,
          { campaign_id: "popup", resource_position: "popup", priority: 1, popup: invalidPopup },
        ]),
      );
      expect(result.deliveries).toEqual([]);
      expect(result.rejectedCount).toBe(2);
    },
  );
  it("rejects the retired card position without dropping a valid popup", () => {
    const result = parseMarketingTouchResponse(
      envelope([
        {
          campaign_id: "legacy",
          resource_position: "card",
          priority: 1,
          card: { background: { type: "image", image: { default: asset } }, buttons: [] },
        },
        { campaign_id: "popup", resource_position: "popup", priority: 1, popup },
      ]),
    );
    expect(result.deliveries.map((delivery) => delivery.campaign_id)).toEqual(["popup"]);
    expect(result.rejectedCount).toBe(1);
  });
  it.each([undefined, null, {}, { color: "red" }])(
    "accepts optional text style %j across both delivery positions",
    (style) => {
      const optionalText = {
        format: "plaintext",
        content: "Hello",
        ...(style === undefined ? {} : { style }),
      };
      const close = { text: optionalText, action: { type: "close", args: null } };
      const content = { title: optionalText, description: optionalText, buttons: [close] };
      const result = parseMarketingTouchResponse(
        envelope([
          {
            campaign_id: "banner",
            resource_position: "banner",
            priority: 1,
            banner: {
              background: { type: "image", image: { default: asset } },
              buttons: [
                close,
                {
                  text: optionalText,
                  action: { type: "claim_zcode_plan", args: { plan_id: "plan" } },
                },
              ],
              success_popup: content,
            },
          },
          { campaign_id: "popup", resource_position: "popup", priority: 1, popup: content },
        ]),
      );
      expect(result.deliveries).toHaveLength(2);
      expect(result.rejectedCount).toBe(0);
    },
  );
  it.each(["red", 1, []])("discards obsolete text style %j", (style) => {
    const result = parseMarketingTouchResponse(
      envelope([
        {
          campaign_id: "popup",
          resource_position: "popup",
          priority: 1,
          popup: { ...popup, title: { ...text, style } },
        },
      ]),
    );
    expect(result.rejectedCount).toBe(0);
    expect(JSON.stringify(result.deliveries)).not.toContain('"style"');
  });
  it.each([
    "default",
    "outline",
    "secondary",
    "ghost",
    "destructive",
    "warning",
    "link",
    "",
    undefined,
  ])("accepts popup variant %s", (variant) => {
    const result = marketingPopupSchema.parse({
      ...popup,
      buttons: [{ ...button(), theme: { variant, class: "rounded-lg", style: "color:red" } }],
    });
    expect(result.buttons[0]?.theme?.variant).toBe(variant || "default");
  });
  it("validates popup theme while ignoring banner theme", () => {
    for (const theme of [
      { variant: "invalid" },
      { class: "x".repeat(513) },
      { style: "x".repeat(513) },
    ]) {
      expect(
        marketingPopupSchema.safeParse({ ...popup, buttons: [{ ...button(), theme }] }).success,
      ).toBe(false);
      const delivery = bannerDelivery("", "");
      Object.assign(delivery.banner.buttons[0]!, { theme });
      const parsed = parseMarketingTouchResponse(envelope([delivery]));
      expect(parsed.rejectedCount).toBe(0);
      expect(JSON.stringify(parsed.deliveries)).not.toContain('"theme"');
    }
  });
  it("accepts existing banner buttons and a popup without a hero", () => {
    const result = parseMarketingTouchResponse(
      envelope([
        {
          campaign_id: "1",
          resource_position: "banner",
          priority: 90,
          banner: {
            background: { type: "image", image: { default: asset } },
            buttons: [
              button(),
              { text, action: { type: "claim_zcode_plan", args: { plan_id: "plan" } } },
            ],
            success_popup: popup,
          },
        },
        { campaign_id: "2", resource_position: "popup", priority: 80, popup },
      ]),
    );
    expect(result.deliveries).toHaveLength(2);
    expect(result.rejectedCount).toBe(0);
  });
  it("rejects ambiguous banner actions independently of a valid popup", () => {
    const action = { text, action: { type: "open_url", args: { url: "https://example.com" } } };
    const result = parseMarketingTouchResponse(
      envelope([
        {
          campaign_id: "1",
          resource_position: "banner",
          priority: 0,
          banner: {
            background: { type: "image", image: { default: asset } },
            buttons: [action, action],
          },
        },
        { campaign_id: "2", resource_position: "popup", priority: 0, popup },
      ]),
    );
    expect(result.deliveries.map((d) => d.campaign_id)).toEqual(["2"]);
    expect(result.rejectedCount).toBe(1);
  });
  it("rejects unsafe URLs, unknown actions and missing plan identifiers", () => {
    for (const action of [
      { type: "open_url", args: { url: "javascript:alert(1)" } },
      { type: "open_url", args: { url: "https://user:pass@example.com" } },
      { type: "open_popup" },
      { type: "claim_zcode_plan", args: {} },
    ])
      expect(marketingActionSchema.safeParse(action).success).toBe(false);
  });
  it("distinguishes empty success from an invalid envelope", () => {
    expect(parseMarketingTouchResponse(envelope([])).deliveries).toEqual([]);
    expect(() => parseMarketingTouchResponse({ code: 500, data: {} })).toThrow();
    expect(() => parseMarketingTouchResponse({ code: 0 })).toThrow();
  });
  it("rejects unknown layouts and unsupported visual types", () => {
    const result = parseMarketingTouchResponse(
      envelope([
        {
          campaign_id: "1",
          resource_position: "popup",
          priority: 0,
          popup: { ...popup, layout: "v2" },
        },
        {
          campaign_id: "2",
          resource_position: "banner",
          priority: 0,
          banner: {
            buttons: [],
            background: { type: "lottie", src: asset },
          },
        },
      ]),
    );
    expect(result.rejectedCount).toBe(2);
  });
});
