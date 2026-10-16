import type { IncomingMessage, ServerResponse } from "node:http";

export function createTelemetryReportFixture() {
  const reports: Array<Record<string, unknown>> = [];
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/__e2e/marketing/telemetry") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reports));
      return true;
    }
    if (path !== "/api/v1/event/report") return false;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    // 只保存格式/一致性断言，不把 JWT 放入 fixture 响应或 WDIO 日志。
    reports.push({
      element: body.element_name,
      authenticated: Boolean(req.headers.authorization),
      bearer: /^Bearer \S+$/.test(req.headers.authorization ?? ""),
      languageMatches: req.headers["x-client-language"] === body.client_language,
      timezoneMatches: req.headers["x-client-timezone"] === body.client_timezone,
      deviceMatches: Boolean(body.device_mid) && req.headers["x-device-mid"] === body.device_mid,
      versionMatches: req.headers["x-zcode-app-version"] === body.app_version,
      osMatches:
        req.headers["x-os-category"] === body.device_os_category &&
        req.headers["x-os-version"] === body.device_os_version,
      userAgentMatches: req.headers["user-agent"] === `ZCode/${body.app_version}`,
      title: req.headers["x-title"],
      platform: Boolean(req.headers["x-platform"]),
      channel: Boolean(req.headers["x-release-channel"]),
      refererMatches: req.headers["http-referer"] === `http://${req.headers.host}`,
    });
    res.writeHead(204);
    res.end();
    return true;
  };
}
