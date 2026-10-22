import { afterEach, expect, it } from "vitest";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createFakeRelayV2, type FakeRelayV2Options } from "@zcode/shared/testing/fake-relay-v2";

const relays: Awaited<ReturnType<typeof createFakeRelayV2>>[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});
async function setup(options: Partial<FakeRelayV2Options> = {}) {
  const relay = await createFakeRelayV2({
    users: { "jwt-alice": "alice", "jwt-bob": "bob" },
    now: () => 1_600_000_000_000,
    ...options,
  });
  relays.push(relay);
  return relay;
}
async function request(
  relay: Awaited<ReturnType<typeof setup>>,
  path: string,
  body?: unknown,
  jwt = "jwt-alice",
) {
  return fetch(`${relay.httpUrl}/api/v1/remote/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("registers, lists and deletes only the authenticated user's devices and records calls", async () => {
  const relay = await setup();
  const registered = await (await request(relay, "device", { device_mid: "machine-1" })).json();
  expect(registered).toMatchObject({
    code: 0,
    data: { device_mid: "machine-1", online: false, meta: {}, created_at: 1_600_000_000 },
  });
  const sid = registered.data.device_sid;
  expect((await (await request(relay, "device")).json()).data).toEqual([registered.data]);
  expect((await (await request(relay, "device", undefined, "jwt-bob")).json()).data).toEqual([]);
  const foreignDelete = await request(relay, "device/delete", { device_sid: sid }, "jwt-bob");
  expect(foreignDelete.status).toBe(200);
  expect(await foreignDelete.json()).toEqual({ code: 1006, msg: "no permission" });
  expect((await request(relay, "device/delete", { device_sid: sid })).ok).toBe(true);
  expect((await (await request(relay, "device")).json()).data).toEqual([]);
  expect((await request(relay, "device", undefined, "invalid")).status).toBe(401);
  expect(relay.httpCalls[0]).toMatchObject({
    method: "POST",
    path: "/api/v1/remote/device",
    userId: "alice",
    body: { device_mid: "machine-1" },
  });
  expect(relay.httpCalls).toHaveLength(7);
});

async function register(relay: Awaited<ReturnType<typeof setup>>) {
  return (await (await request(relay, "device", { device_mid: "machine" })).json()).data
    .device_sid as string;
}
async function token(
  relay: Awaited<ReturnType<typeof setup>>,
  role: "device" | "terminal",
  jwt = "jwt-alice",
) {
  const response = await request(relay, "token", { role }, jwt);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()).data.token as string;
}
async function connect(relay: Awaited<ReturnType<typeof setup>>, credential: string) {
  const ws = new WebSocket(`${relay.wsUrl}?token=${credential}`);
  const messages: unknown[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(ws, "open");
  return { ws, messages, send: (message: unknown) => ws.send(JSON.stringify(message)) };
}
async function authenticate(
  relay: Awaited<ReturnType<typeof setup>>,
  sid: string,
  role: "device" | "terminal",
) {
  const client = await connect(relay, await token(relay, role));
  client.send({
    type: "auth_init",
    device_sid: sid,
    meta: { name: role },
    client_ts: 1_600_000_000,
  });
  await expect
    .poll(() => client.messages)
    .toEqual(expect.arrayContaining([expect.objectContaining({ type: "auth_ack" })]));
  return client;
}

it("pairs both roles, reports online meta and forwards opaque payloads with server seconds", async () => {
  const relay = await setup();
  const sid = await register(relay);
  const device = await authenticate(relay, sid, "device");
  expect(device.messages[0]).toMatchObject({
    type: "auth_ack",
    pair_status: "waiting",
    terminal_sid: "",
  });
  const terminal = await authenticate(relay, sid, "terminal");
  expect(terminal.messages[0]).toMatchObject({
    type: "auth_ack",
    pair_status: "matched",
    terminal_sid: expect.stringMatching(/^t_/),
  });
  await expect
    .poll(() => device.messages)
    .toContainEqual({
      type: "pair_status_ack",
      pair_status: "matched",
      terminal_sid: "",
      server_ts: 1_600_000_000,
    });
  expect((await (await request(relay, "device")).json()).data[0]).toMatchObject({
    online: true,
    meta: { name: "device" },
  });
  const onlineDelete = await request(relay, "device/delete", { device_sid: sid });
  expect(onlineDelete.status).toBe(400);
  expect(await onlineDelete.json()).toEqual({ code: 3005, msg: "wrong status" });
  const payload = { user_id: "bob", device_sid: "not-the-route", arbitrary: [1, null, "中文"] };
  terminal.send({ type: "data", payload, client_ts: 1 });
  await expect
    .poll(() => device.messages)
    .toContainEqual({ type: "data", payload, server_ts: 1_600_000_000 });
  device.send({ type: "data", payload: "reply", client_ts: 2 });
  await expect
    .poll(() => terminal.messages)
    .toContainEqual({ type: "data", payload: "reply", server_ts: 1_600_000_000 });
  device.send({ type: "pair_status_query", client_ts: 1_600_000_005 });
  await expect
    .poll(() => device.messages)
    .toContainEqual({
      type: "pair_status_ack",
      pair_status: "matched",
      terminal_sid: expect.stringMatching(/^t_/),
      server_ts: 1_600_000_000,
    });
  expect(relay.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "terminal",
        userId: "alice",
        message: { type: "data", payload, client_ts: 1 },
      }),
    ]),
  );
});

it.each(["device", "terminal"] as const)(
  "replaces the old %s without stale close clearing the new owner",
  async (role) => {
    const relay = await setup();
    const sid = await register(relay);
    const device = await authenticate(relay, sid, "device");
    const terminal = await authenticate(relay, sid, "terminal");
    const old = role === "device" ? device : terminal;
    const other = role === "device" ? terminal : device;
    const replacement = await authenticate(relay, sid, role);
    await expect
      .poll(() => old.messages)
      .toContainEqual({ type: "error", code: "KICKED", server_ts: 1_600_000_000 });
    await expect.poll(() => old.ws.readyState).toBe(WebSocket.CLOSED);
    other.send({ type: "data", payload: "new owner" });
    await expect
      .poll(() => replacement.messages)
      .toContainEqual({ type: "data", payload: "new owner", server_ts: 1_600_000_000 });
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  },
);

it("notifies terminal of device offline and removes live meta from the list", async () => {
  const relay = await setup();
  const sid = await register(relay);
  const device = await authenticate(relay, sid, "device");
  const terminal = await authenticate(relay, sid, "terminal");
  device.ws.close();
  await expect.poll(() => terminal.ws.readyState).toBe(WebSocket.CLOSED);
  expect(terminal.messages.slice(-2)).toEqual([
    { type: "pair_status_ack", pair_status: "waiting", terminal_sid: "", server_ts: 1_600_000_000 },
    { type: "error", code: "DEVICE_OFFLINE", server_ts: 1_600_000_000 },
  ]);
  expect((await (await request(relay, "device")).json()).data[0]).toMatchObject({
    online: false,
    meta: {},
  });
});

it("consumes tokens once, rejects foreign devices before takeover and forbids reauthentication", async () => {
  const relay = await setup();
  const sid = await register(relay);
  const device = await authenticate(relay, sid, "device");
  const credential = await token(relay, "device", "jwt-bob");
  const foreign = await connect(relay, credential);
  foreign.send({ type: "auth_init", device_sid: sid });
  await expect.poll(() => foreign.ws.readyState).toBe(WebSocket.CLOSED);
  expect(foreign.messages).toEqual([
    { type: "error", code: "AUTH_FAILED", server_ts: 1_600_000_000 },
  ]);
  expect(device.ws.readyState).toBe(WebSocket.OPEN);
  const reused = new WebSocket(`${relay.wsUrl}?token=${credential}`);
  const error = await new Promise<Error>((resolve) => reused.once("error", resolve));
  expect(error.message).toContain("401");
  device.send({ type: "auth_init", device_sid: sid });
  await expect.poll(() => device.ws.readyState).toBe(WebSocket.CLOSED);
  expect(device.messages.at(-1)).toMatchObject({ type: "error", code: "WRONG_PARAM" });
});

it.each([
  [{ type: "data", payload: "before-auth" }, "AUTH_FAILED"],
  [{ type: "pair_status_query" }, "AUTH_FAILED"],
  [{ type: "auth_init", device_sid: "d_1", role: "device" }, "WRONG_PARAM"],
  ["invalid-json", "WRONG_PARAM"],
] as const)("records and rejects invalid handshake %j", async (message, code) => {
  const relay = await setup();
  const client = await connect(relay, await token(relay, "terminal"));
  if (typeof message === "string") client.ws.send(message);
  else client.send(message);
  await expect.poll(() => client.ws.readyState).toBe(WebSocket.CLOSED);
  expect(client.messages).toEqual([{ type: "error", code, server_ts: 1_600_000_000 }]);
  expect(relay.messages[0]).toMatchObject({ message });
});

it("orchestrates ACK state and suppresses replies without creating a phantom peer", async () => {
  let drop = false;
  const relay = await setup({
    onMessage: () => (drop ? { drop: true } : { pairStatus: "matched" }),
  });
  const sid = await register(relay);
  const client = await authenticate(relay, sid, "device");
  expect(client.messages[0]).toMatchObject({ type: "auth_ack", pair_status: "matched" });
  client.send({ type: "pair_status_query" });
  await expect
    .poll(() => client.messages)
    .toContainEqual({
      type: "pair_status_ack",
      pair_status: "matched",
      terminal_sid: "",
      server_ts: 1_600_000_000,
    });
  drop = true;
  const before = client.messages.length;
  client.send({ type: "pair_status_query" });
  await expect.poll(() => relay.messages).toHaveLength(3);
  // 后续 Ping/Pong 是同一 WS 的有序屏障，证明被丢弃查询之后没有隐藏 ACK。
  const pong = once(client.ws, "pong");
  client.ws.ping();
  await pong;
  expect(client.messages).toHaveLength(before);
  drop = false;
  client.send({ type: "data", payload: "no real peer" });
  await expect
    .poll(() => client.messages.at(-1))
    .toMatchObject({ type: "error", code: "INTERNAL" });
});

it.each(["AUTH_FAILED", "WRONG_PARAM", "KICKED", "INTERNAL", "DEVICE_OFFLINE"] as const)(
  "injects %s during authentication and by connection target",
  async (code) => {
    let rejectAuth = true;
    const relay = await setup({ onMessage: () => (rejectAuth ? { error: code } : undefined) });
    const sid = await register(relay);
    const rejected = await connect(relay, await token(relay, "device"));
    rejected.send({ type: "auth_init", device_sid: sid });
    await expect.poll(() => rejected.ws.readyState).toBe(WebSocket.CLOSED);
    expect(rejected.messages).toEqual([{ type: "error", code, server_ts: 1_600_000_000 }]);
    rejectAuth = false;
    const accepted = await authenticate(relay, sid, "device");
    relay.sendError({ deviceSid: sid, role: "device" }, code);
    await expect.poll(() => accepted.messages.at(-1)).toMatchObject({ type: "error", code });
    relay.disconnect({ connectionId: relay.messages.at(-1)!.connectionId });
    await expect.poll(() => accepted.ws.readyState).toBe(WebSocket.CLOSED);
  },
);

it("injects HTTP 401, 5xx and network failures and records every attempted request", async () => {
  let failure: ReturnType<NonNullable<FakeRelayV2Options["onHttp"]>>;
  const relay = await setup({ onHttp: () => failure });
  for (const status of [401, 503]) {
    failure = { status, body: { code: status, msg: "injected" } };
    const response = await request(relay, "token", { role: "terminal" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code: status, msg: "injected" });
  }
  failure = { networkError: true };
  await expect(request(relay, "token", { role: "device" })).rejects.toThrow();
  failure = undefined;
  expect((await request(relay, "token", { role: "device" })).ok).toBe(true);
  expect(relay.httpCalls).toHaveLength(4);
});

it("expires unused tokens at 60 seconds without expiring established sockets", async () => {
  let now = 1_600_000_000_000;
  const relay = await setup({ now: () => now });
  const sid = await register(relay);
  const used = await token(relay, "device");
  const client = await connect(relay, used);
  client.send({ type: "auth_init", device_sid: sid });
  await expect.poll(() => client.messages.at(-1)).toMatchObject({ type: "auth_ack" });
  const unused = await token(relay, "terminal");
  now += 60_000;
  for (const credential of [unused, used, "", "not-a-token"]) {
    const ws = new WebSocket(`${relay.wsUrl}?token=${credential}`);
    expect((await new Promise<Error>((resolve) => ws.once("error", resolve))).message).toContain(
      "401",
    );
  }
  client.send({ type: "pair_status_query" });
  await expect
    .poll(() => client.messages.at(-1))
    .toMatchObject({ type: "pair_status_ack", server_ts: 1_600_000_060 });
  expect(client.ws.readyState).toBe(WebSocket.OPEN);
});

it("serves a standard browser-compatible WebSocket alongside a Node ws client", async () => {
  const relay = await setup();
  const sid = await register(relay);
  const device = await authenticate(relay, sid, "device");
  const ws = new globalThis.WebSocket(
    `${relay.wsUrl}?token=${await token(relay, "terminal")}&mid=machine`,
  );
  const messages: unknown[] = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.send(JSON.stringify({ type: "auth_init", device_sid: sid, meta: { platform: "browser" } }));
  await expect.poll(() => messages[0]).toMatchObject({ type: "auth_ack", pair_status: "matched" });
  device.send({ type: "data", payload: { op: "browser" } });
  await expect
    .poll(() => messages.at(-1))
    .toMatchObject({ type: "data", payload: { op: "browser" } });
  ws.send(JSON.stringify({ type: "data", payload: "node" }));
  await expect.poll(() => device.messages.at(-1)).toMatchObject({ type: "data", payload: "node" });
  ws.close();
  await expect
    .poll(() => device.messages.at(-1))
    .toMatchObject({ type: "pair_status_ack", pair_status: "waiting" });
});

it("never merges identical MIDs and refuses deleted SIDs even with a fresh token", async () => {
  const relay = await setup();
  const first = await register(relay);
  const second = await register(relay);
  expect(first).not.toBe(second);
  await request(relay, "device/delete", { device_sid: first });
  const client = await connect(relay, await token(relay, "terminal"));
  client.send({ type: "auth_init", device_sid: first });
  await expect.poll(() => client.ws.readyState).toBe(WebSocket.CLOSED);
  expect(client.messages.at(-1)).toMatchObject({ type: "error", code: "AUTH_FAILED" });
});

it("requires Bearer authentication and permits browser HTTP preflight", async () => {
  const relay = await setup();
  const response = await fetch(`${relay.httpUrl}/api/v1/remote/device`, {
    headers: { Authorization: "jwt-alice" },
  });
  expect(response.status).toBe(401);
  const preflight = await fetch(`${relay.httpUrl}/api/v1/remote/token`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
});

it("deletes missing devices idempotently", async () => {
  const relay = await setup();
  const response = await request(relay, "device/delete", { device_sid: "d_missing" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 0, msg: "" });
});

it.each([
  ["token", { role: "admin" }],
  ["device", { device_mid: "machine", user_id: "bob" }],
  ["device/delete", { device_sid: " " }],
] as const)(
  "rejects invalid %s bodies with the staging parameter error envelope",
  async (path, body) => {
    const relay = await setup();
    const response = await request(relay, path, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 3001, msg: "parameter error" });
    expect(relay.httpCalls[0]?.body).toEqual(body);
  },
);
