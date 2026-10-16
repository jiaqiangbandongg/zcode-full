import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMarketingTouchAssets } from "./marketing-touch-assets.js";
import { createMarketingAssetGate } from "./marketing-touch-asset-gate.js";
import { createTelemetryReportFixture } from "./telemetry-report-fixture.js";

export async function createMarketingTouchFixture() {
  const { png, zip, assets } = await createMarketingTouchAssets();
  const assetGate = createMarketingAssetGate();
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const events: unknown[] = [];
  const handleTelemetry = createTelemetryReportFixture();
  let held = true;
  let claimed = false;
  let claimFailure: unknown = null;
  let popupVisible = true;
  let actionDelivery: { campaign_id: string; [key: string]: unknown } | null = null;
  let actionSequence = 0;
  const waiters: Array<() => void> = [];
  const queryWaiters: Array<() => void> = [];
  let queryHeld = false;
  const requests: string[] = [];
  const requestDetails: Array<{
    method: string;
    path: string;
    seq: string | null;
    timestamp: number;
    headers: {
      deviceMid: string | string[] | undefined;
      language: string | string[] | undefined;
      appVersion: string | string[] | undefined;
      authenticated: boolean;
    };
  }> = [];
  let generation = 0;
  let overrideDeliveries: unknown[] | null = null;
  let queryStatus = 200;
  let reportStatus = 200;
  let video = Buffer.alloc(0);
  const text = (content: string) => ({ format: "plaintext", content, style: null });
  const close = { text: text("Close campaign"), action: { type: "close" } };
  return {
    stop() {
      assetGate.reset();
      waiters.splice(0).forEach((done) => done());
      queryWaiters.splice(0).forEach((done) => done());
    },
    async handle(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const assetControl = assetGate.control(path);
      if (await handleTelemetry(req, res)) return true;
      if (assetControl) {
        json(assetControl);
        return true;
      }
      if (path === "/__e2e/marketing/state") {
        json({ events, requests, requestDetails, pendingQueries: queryWaiters.length });
        return true;
      }
      if (path.startsWith("/__e2e/marketing/query-")) {
        if (path.endsWith("/query-hold")) queryHeld = true;
        else if (path.endsWith("/query-release-one")) queryWaiters.shift()?.();
        else if (path.endsWith("/query-release-all")) {
          queryHeld = false;
          queryWaiters.splice(0).forEach((done) => done());
        } else return false;
        json({ ok: true });
        return true;
      }
      if (path === "/__e2e/marketing/assets") {
        json(
          Object.fromEntries(
            Object.entries(assets).map(([key, asset]) => [
              key,
              { src: `http://${req.headers.host}${asset.path}`, sha256: hash(asset.bytes) },
            ]),
          ),
        );
        return true;
      }
      if (path === "/__e2e/marketing/reset") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const options = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        // 旧用例挂起的 claim 不能在 reset 后改写下一用例的服务端投放。
        generation++;
        assetGate.reset();
        queryHeld = false;
        queryWaiters.splice(0).forEach((done) => done());
        waiters.splice(0).forEach((done) => done());
        held = options.held === true;
        claimed = options.banner !== true;
        popupVisible = options.popup === true;
        claimFailure = null;
        actionDelivery = null;
        overrideDeliveries = Array.isArray(options.deliveries) ? options.deliveries : null;
        queryStatus = 200;
        reportStatus = 200;
        events.length = 0;
        requests.length = 0;
        requestDetails.length = 0;
        json({ ok: true });
        return true;
      }
      if (path === "/__e2e/marketing/faults") {
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(Buffer.from(chunk));
        const options = JSON.parse(Buffer.concat(body).toString() || "{}");
        queryStatus = options.queryStatus ?? 200;
        reportStatus = options.reportStatus ?? 200;
        json({ ok: true });
        return true;
      }
      if (path === "/__e2e/marketing/claim-failure") {
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(Buffer.from(chunk));
        claimFailure = JSON.parse(Buffer.concat(body).toString());
        claimed = false;
        actionDelivery = null;
        held = false;
        json({ ok: true });
        return true;
      }
      if (path === "/__e2e/marketing/rich-delivery" || path === "/__e2e/marketing/video-banner") {
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(Buffer.from(chunk));
        const data = JSON.parse(Buffer.concat(body).toString());
        const campaignId = `rich-${++actionSequence}`;
        const origin = `http://${req.headers.host}`;
        if (path.endsWith("video-banner")) {
          video = Buffer.from(data.video, "base64");
          actionDelivery = {
            campaign_id: campaignId,
            resource_position: "banner",
            priority: 100,
            banner: {
              background: {
                type: "video",
                video: {
                  src: { src: `${origin}/marketing-assets/banner.mp4`, sha256: hash(video) },
                  fallback: { src: `${origin}/marketing-assets/banner.png`, sha256: hash(png) },
                },
              },
              buttons: [
                close,
                {
                  text: text("Copy video"),
                  action: { type: "copy_text", args: { text: "Video copied" } },
                },
              ],
            },
          };
        } else {
          actionDelivery = {
            campaign_id: campaignId,
            resource_position: "popup",
            priority: 100,
            popup: data,
          };
        }
        json({ campaignId });
        return true;
      }
      if (path === "/marketing-assets/banner.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(video);
        return true;
      }
      if (path === "/__e2e/marketing/bundle-banner") {
        const origin = `http://${req.headers.host}`;
        const campaignId = `bundle-banner-${++actionSequence}`;
        actionDelivery = {
          campaign_id: campaignId,
          resource_position: "banner",
          priority: 100,
          banner: {
            background: {
              type: "bundle",
              bundle: {
                bundle: { src: `${origin}/marketing-assets/hero.zip`, sha256: hash(zip) },
                entry: "index.html",
              },
              args: {
                planName: "E2E Bundle Banner",
                amountValue: "321",
                amountUnit: "tokens",
                benefits: ["Banner resource"],
              },
            },
            buttons: [
              { ...close, text: { ...text(""), format: "" } },
              {
                text: text(""),
                action: { type: "copy_text", args: { text: "Bundle banner copied" } },
              },
            ],
          },
        };
        json({ campaignId });
        return true;
      }
      if (
        path === "/__e2e/marketing/action-delivery" ||
        path === "/__e2e/marketing/html-delivery"
      ) {
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(Buffer.from(chunk));
        const action = JSON.parse(Buffer.concat(body).toString());
        const campaignId = `action-test-${++actionSequence}`;
        actionDelivery = {
          campaign_id: campaignId,
          resource_position: "popup",
          priority: 100,
          popup: {
            title: text(`E2E actions ${campaignId}`),
            description: path.endsWith("html-delivery")
              ? { format: "html", content: action }
              : text("Action fixture"),
            buttons: path.endsWith("html-delivery")
              ? [
                  {
                    ...close,
                    theme: {
                      variant: "outline",
                      class: "rounded-lg font-semibold",
                      style: "font-weight:400;color:var(--color-foreground);position:fixed",
                    },
                  },
                ]
              : [{ text: text("Run action"), action }, close],
          },
        };
        json({ ok: true, campaignId });
        return true;
      }
      if (path === "/__e2e/marketing/release") {
        held = false;
        waiters.splice(0).forEach((done) => done());
        json({ ok: true });
        return true;
      }
      if (path === "/__e2e/marketing/redeliver-banner") {
        claimed = false;
        json({ ok: true });
        return true;
      }
      if (path === "/__e2e/marketing/redeliver-popup") {
        popupVisible = true;
        json({ ok: true });
        return true;
      }
      if (
        path.startsWith("/api/v1/marketing/") ||
        path.startsWith("/marketing-assets/") ||
        path.startsWith("/api/v1/zcode-plan/billing/")
      ) {
        requests.push(path);
        requestDetails.push({
          method: req.method ?? "GET",
          path,
          seq: url.searchParams.get("seq"),
          timestamp: Date.now(),
          headers: {
            deviceMid: req.headers["x-device-mid"],
            language: req.headers["x-client-language"],
            appVersion: req.headers["x-zcode-app-version"],
            authenticated: Boolean(req.headers.authorization),
          },
        });
      }
      const staticAsset = Object.values(assets).find((asset) => asset.path === path);
      if (staticAsset) {
        await assetGate.wait();
        res.writeHead(200, { "Content-Type": staticAsset.type });
        res.end(staticAsset.bytes);
        return true;
      }
      if (path === "/api/v1/marketing/touch/action") {
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(Buffer.from(chunk));
        const event = JSON.parse(Buffer.concat(body).toString());
        events.push(event);
        if (reportStatus !== 200) {
          json({ code: reportStatus, data: { message: "E2E report fault" } }, reportStatus);
          return true;
        }
        if (event.campaign_id === actionDelivery?.campaign_id) actionDelivery = null;
        // 是否继续投放由服务端 fixture 决定；重新下发保留原 campaign_id。
        if (event.campaign_id === "independent") popupVisible = false;
        if (event.campaign_id === "banner-1") claimed = true;
        json({ code: 0 });
        return true;
      }
      if (path === "/api/v1/marketing/touch") {
        if (queryStatus !== 200) {
          json({ code: queryStatus, data: { message: "E2E query fault" } }, queryStatus);
          return true;
        }
        const origin = `http://${req.headers.host}`;
        const hero = {
          type: "bundle",
          bundle: {
            bundle: { src: `${origin}/marketing-assets/hero.zip`, sha256: hash(zip) },
            entry: "index.html",
          },
          args: {
            planName: "E2E Weekend",
            amountValue: "100",
            amountUnit: "tokens",
            benefits: ["Fixture benefit"],
          },
        };
        const result = {
          layout: "v1",
          title: text("E2E claim succeeded"),
          description: { format: "html", content: "<p><b>E2E result</b></p>" },
          hero,
          buttons: [close],
        };
        const snapshot = {
          code: 0,
          data: {
            server_time: Math.floor(Date.now() / 1000),
            language: req.headers["x-client-language"] === "zh-CN" ? "zh-CN" : "en-US",
            deliveries:
              overrideDeliveries ??
              (actionDelivery
                ? [actionDelivery]
                : [
                    ...(!claimed
                      ? [
                          {
                            campaign_id: "banner-1",
                            resource_position: "banner",
                            priority: 90,
                            banner: {
                              background: {
                                type: "image",
                                image: {
                                  default: {
                                    src: `${origin}/marketing-assets/banner.png`,
                                    sha256: hash(png),
                                  },
                                },
                              },
                              buttons: [
                                { ...close, text: { ...text(""), format: "" } },
                                {
                                  text: { ...text(""), format: "" },
                                  action: {
                                    type: "claim_zcode_plan",
                                    args: { plan_id: "weekend-plan-e2e" },
                                  },
                                },
                              ],
                              success_popup: result,
                            },
                          },
                        ]
                      : []),
                    ...(popupVisible
                      ? [
                          {
                            campaign_id: "independent",
                            resource_position: "popup",
                            priority: 100,
                            popup: { ...result, title: text("E2E independent popup"), hero: null },
                          },
                        ]
                      : []),
                  ]),
          },
        };
        // 在操作前冻结响应；释放时不重新计算投放，才能复现真实迟到快照。
        if (queryHeld) await new Promise<void>((done) => queryWaiters.push(done));
        json(snapshot);
        return true;
      }
      if (path === "/api/v1/zcode-plan/billing/claim") {
        const requestGeneration = generation;
        if (held) await new Promise<void>((done) => waiters.push(done));
        if (requestGeneration !== generation) {
          json({ code: 409, data: { message: "Fixture case reset" } });
          return true;
        }
        claimed = true;
        if (claimFailure) {
          json(claimFailure);
          claimFailure = null;
          return true;
        }
      }
      return false;
    },
  };
}
