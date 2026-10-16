import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createOffPeakServerClient,
  OffPeakServerError,
} from "../src/session/offPeakServerClient.js";
import {
  startOffPeakMockGateway,
  isOffPeakMockEnabled,
  type OffPeakMockGatewayHandle,
} from "../src/session/offPeakMockGateway.js";
import { createServiceLogger } from "../src/logger/serviceLogger.js";

const logger = createServiceLogger("off-peak-test", { isDebugEnabled: false });

const credentials = {
  jwt: "jwt-token",
  codingPlanApiKey: "cp-key",
  kind: "bigmodel-personal" as const,
  providerFamily: "bigmodel" as const,
  providerId: "account:bigmodel-individual-coding-plan",
  selectedConnectionKey: "coding-plan:account:bigmodel-individual-coding-plan",
};

const teamCredentials = {
  jwt: "team-zcode-jwt",
  codingPlanApiKey: "team-api-key.team-secret-key",
  kind: "bigmodel-team" as const,
  providerFamily: "bigmodel" as const,
  providerId: "account:bigmodel-individual-coding-plan",
  selectedConnectionKey:
    "team-plan:account:bigmodel-individual-coding-plan:team-pro:org-team:project-team",
  organizationId: "org-team",
  projectId: "project-team",
};

function makeClient(origin: string) {
  return createOffPeakServerClient({
    resolveOrigin: () => origin,
    resolveCredentials: async () => credentials,
    logger,
  });
}

describe("offPeakServerClient × offPeakMockGateway 契约联测", () => {
  let gateway: OffPeakMockGatewayHandle;
  let upstream: Server;
  let upstreamOrigin: string;
  let upstreamRequests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;

  beforeEach(async () => {
    upstreamRequests = [];
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        upstreamRequests.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "x-upstream": "yes",
        });
        res.end(
          JSON.stringify({
            id: "msg_mock",
            content: [{ type: "text", text: "ok" }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream bind failed");
    upstreamOrigin = `http://127.0.0.1:${address.port}`;
    gateway = await startOffPeakMockGateway(
      {
        logger,
        resolveUpstream: async () => ({
          url: `${upstreamOrigin}/v1/messages`,
          headers: { authorization: "Bearer upstream-key" },
        }),
      },
      {
        readyDelayMs: 0,
        readyTtlMs: 60_000,
        activeMs: 60_000,
        queue429Count: 0,
        nextPollS: 1,
        port: 0,
      },
    );
  });

  afterEach(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("取号：readyDelay=0 时取号即 ready；同 task_id 重取号旧票作废", async () => {
    const client = makeClient(gateway.origin);
    await expect(client.getTakeNumberAvailability()).resolves.toEqual({
      canTakeNumber: true,
    });
    const first = await client.takeTicket("task-1");
    expect(first.state).toBe("ready");
    expect(first.position).toBeUndefined();
    expect(first.nextPollAfterMs).toBe(1000);

    const second = await client.takeTicket("task-1");
    expect(second.ticketId).not.toBe(first.ticketId);
    const status = await client.batchStatus([first.ticketId, second.ticketId]);
    expect(status.tickets.find((t) => t.ticketId === first.ticketId)?.state).toBe("expired");
    expect(status.tickets.find((t) => t.ticketId === second.ticketId)?.state).toBe("ready");
    expect(status.tickets.every((ticket) => ticket.position === undefined)).toBe(true);
  });

  it("额度快照：不可创建时返回服务端 next_take_at", async () => {
    await gateway.close();
    gateway = await startOffPeakMockGateway(
      {
        logger,
        resolveUpstream: async () => null,
      },
      { availabilityBlockedMs: 60_000, port: 0 },
    );
    const availability = await makeClient(gateway.origin).getTakeNumberAvailability();
    expect(availability.canTakeNumber).toBe(false);
    expect(availability.nextTakeAt).toBeGreaterThan(Date.now());
  });

  it("批量状态：未知票回 not_found；轮询触发 queued→ready 晋级", async () => {
    await gateway.close();
    gateway = await startOffPeakMockGateway(
      {
        logger,
        resolveUpstream: async () => ({
          url: `${upstreamOrigin}/v1/messages`,
          headers: {},
        }),
      },
      { readyDelayMs: 30, readyTtlMs: 60_000, activeMs: 60_000, port: 0 },
    );
    const client = makeClient(gateway.origin);
    const taken = await client.takeTicket("task-2");
    expect(taken.state).toBe("queued");
    expect(taken.position).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await client.batchStatus([taken.ticketId, "ghost"]);
    expect(status.tickets.find((t) => t.ticketId === taken.ticketId)?.state).toBe("ready");
    expect(status.tickets.find((t) => t.ticketId === "ghost")?.state).toBe("not_found");
  });

  it("messages：429 注入 N 次后准入并代理上游（含 SSE 头透传语义）；settle 幂等", async () => {
    await gateway.close();
    gateway = await startOffPeakMockGateway(
      {
        logger,
        resolveUpstream: async () => ({
          url: `${upstreamOrigin}/v1/messages`,
          headers: { authorization: "Bearer upstream-key" },
        }),
      },
      {
        readyDelayMs: 0,
        queue429Count: 2,
        retryAfterS: 7,
        activeMs: 60_000,
        port: 0,
      },
    );
    const client = makeClient(gateway.origin);
    const taken = await client.takeTicket("task-3");

    const send = () =>
      fetch(`${gateway.origin}/api/v1/off-peak/anthropic/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-off-peak-ticket-id": taken.ticketId,
        },
        body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
      });

    const first = await send();
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("7");
    expect(((await first.json()) as { code: number }).code).toBe(3105);
    const second = await send();
    expect(second.status).toBe(429);

    const admitted = await send();
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("x-upstream")).toBe("yes");
    expect(((await admitted.json()) as { id: string }).id).toBe("msg_mock");
    // 上游收到了鉴权头与原始 body
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.headers["authorization"]).toBe("Bearer upstream-key");
    expect(upstreamRequests[0]!.body).toContain("GLM-5.2");

    await client.settle(taken.ticketId);
    await client.settle(taken.ticketId); // 幂等
    const after = await client.batchStatus([taken.ticketId]);
    expect(after.tickets[0]!.state).toBe("settled");
  });

  it("messages：active 到期后返回 400/3102（触发续跑）；未知票同样 3102", async () => {
    await gateway.close();
    gateway = await startOffPeakMockGateway(
      {
        logger,
        resolveUpstream: async () => ({
          url: `${upstreamOrigin}/v1/messages`,
          headers: {},
        }),
      },
      { readyDelayMs: 0, activeMs: 30, port: 0 },
    );
    const client = makeClient(gateway.origin);
    const taken = await client.takeTicket("task-4");
    const send = (ticketId: string) =>
      fetch(`${gateway.origin}/api/v1/off-peak/anthropic/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-off-peak-ticket-id": ticketId,
        },
        body: JSON.stringify({ messages: [] }),
      });

    expect((await send(taken.ticketId)).status).toBe(200); // 准入 → active
    await new Promise((resolve) => setTimeout(resolve, 60)); // 超过 activeMs
    const expired = await send(taken.ticketId);
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { code: number }).code).toBe(3102);

    const unknown = await send("no-such-ticket");
    expect(((await unknown.json()) as { code: number }).code).toBe(3102);
  });

  it("客户端错误映射：非 2xx 抛 OffPeakServerError 携带 bizCode", async () => {
    // 手写一个只回 429/3103 的假服务端
    const denyServer = createServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 3103,
          msg: "take quota exhausted",
          data: { next_take_at: 1234 },
        }),
      );
    });
    await new Promise<void>((resolve) => denyServer.listen(0, "127.0.0.1", resolve));
    const address = denyServer.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    try {
      const client = makeClient(`http://127.0.0.1:${address.port}`);
      const error = await client.takeTicket("task-x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OffPeakServerError);
      expect((error as OffPeakServerError).httpStatus).toBe(429);
      expect((error as OffPeakServerError).bizCode).toBe(3103);
      expect((error as OffPeakServerError).nextTakeAt).toBe(1234);
    } finally {
      await new Promise<void>((resolve) => denyServer.close(() => resolve()));
    }
  });

  it("Team 凭证请求保持双头一致，并区分 2007 与裸 429", async () => {
    const requests: Array<{ path: string; headers: Headers }> = [];
    const warnings: unknown[][] = [];
    const diagnosticLogger = createServiceLogger("off-peak-team-test", {
      isDebugEnabled: false,
      sink: {
        log: () => undefined,
        warn: (...args) => warnings.push(args),
        error: () => undefined,
      },
    });
    const client = createOffPeakServerClient({
      resolveOrigin: () => "https://offpeak.example.test",
      resolveCredentials: async () => teamCredentials,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, headers: new Headers(init?.headers) });
        if (path.endsWith("/ticket/availability")) {
          return new Response(JSON.stringify({ code: 2007, msg: "http error" }), {
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req-team-availability",
            },
          });
        }
        return new Response(null, {
          status: 429,
          headers: { "x-request-id": "req-team-take" },
        });
      },
      logger: diagnosticLogger,
    });

    const availabilityError = await client
      .getTakeNumberAvailability()
      .catch((error: unknown) => error);
    expect(availabilityError).toBeInstanceOf(OffPeakServerError);
    expect(availabilityError).toMatchObject({
      httpStatus: 500,
      bizCode: 2007,
      requestId: "req-team-availability",
    });

    const takeError = await client.takeTicket("team-task").catch((error: unknown) => error);
    expect(takeError).toBeInstanceOf(OffPeakServerError);
    expect(takeError).toMatchObject({
      httpStatus: 429,
      bizCode: undefined,
      requestId: "req-team-take",
    });

    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/off-peak/ticket/availability",
      "/api/v1/off-peak/ticket",
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer team-zcode-jwt");
      expect(request.headers.get("x-coding-plan-api-key")).toBe("team-api-key.team-secret-key");
      expect(request.headers.get("bigmodel-organization")).toBe("org-team");
      expect(request.headers.get("bigmodel-project")).toBe("project-team");
      expect(request.headers.get("x-request-id")).toBeTruthy();
      expect(request.headers.get("user-agent")).toMatch(/^ZCode\//);
      expect(request.headers.get("http-referer")).toBeTruthy();
    }
    const serializedWarnings = JSON.stringify(warnings);
    expect(serializedWarnings).toContain("bigmodel-team");
    expect(serializedWarnings).toContain("req-team-availability");
    expect(serializedWarnings).toContain("req-team-take");
    expect(serializedWarnings).not.toContain(teamCredentials.jwt);
    expect(serializedWarnings).not.toContain(teamCredentials.codingPlanApiKey);
  });

  it("availability/take/status/settle 都从同一 resolver snapshot 注入 Team 凭证与身份", async () => {
    const requests: Array<{ path: string; headers: Headers }> = [];
    let resolveCalls = 0;
    const client = createOffPeakServerClient({
      resolveOrigin: () => "https://offpeak.example.test",
      resolveCredentials: async () => {
        resolveCalls += 1;
        return teamCredentials;
      },
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, headers: new Headers(init?.headers) });
        const body = path.endsWith("/ticket/availability")
          ? { can_take_number: true }
          : path.endsWith("/ticket/status")
            ? { tickets: [{ ticket_id: "ticket-1", state: "ready" }] }
            : path.endsWith("/settle")
              ? { ticket_id: "ticket-1", state: "settled" }
              : { ticket_id: "ticket-1", state: "queued" };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      logger,
    });

    await client.getTakeNumberAvailability();
    await client.takeTicket("task-1");
    await client.batchStatus(["ticket-1"]);
    await client.settle("ticket-1");

    expect(resolveCalls).toBe(4);
    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/off-peak/ticket/availability",
      "/api/v1/off-peak/ticket",
      "/api/v1/off-peak/ticket/status",
      "/api/v1/off-peak/ticket/ticket-1/settle",
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer team-zcode-jwt");
      expect(request.headers.get("x-coding-plan-api-key")).toBe("team-api-key.team-secret-key");
      expect(request.headers.get("bigmodel-organization")).toBe("org-team");
      expect(request.headers.get("bigmodel-project")).toBe("project-team");
    }
  });

  it("个人套餐和旧版 Team key 不发送不完整的 organization/project", async () => {
    const snapshots = [
      credentials,
      {
        ...teamCredentials,
        organizationId: undefined,
        projectId: "legacy-project",
      },
    ];
    const requests: Headers[] = [];
    const client = createOffPeakServerClient({
      resolveOrigin: () => "https://offpeak.example.test",
      resolveCredentials: async () => snapshots.shift()!,
      fetchImpl: async (_input, init) => {
        requests.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ can_take_number: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      logger,
    });

    await client.getTakeNumberAvailability();
    await client.getTakeNumberAvailability();

    for (const headers of requests) {
      expect(headers.has("bigmodel-organization")).toBe(false);
      expect(headers.has("bigmodel-project")).toBe(false);
    }
  });

  it("isOffPeakMockEnabled：仅 ZCODE_OFFPEAK_MOCK=1 开启", () => {
    expect(isOffPeakMockEnabled({ ZCODE_OFFPEAK_MOCK: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOffPeakMockEnabled({ ZCODE_OFFPEAK_MOCK: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOffPeakMockEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
