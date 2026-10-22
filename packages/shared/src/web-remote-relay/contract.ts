import { z } from "zod";

// 请求与 WebSocket 消息严格校验 V2，HTTP 响应允许新增字段。
const unixSeconds = z.number().int().min(0).max(253_402_300_799);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const deviceSid = identifier.refine((value) => new TextEncoder().encode(value).length <= 128);
const meta = z.strictObject({
  name: z.string().optional(),
  platform: z.string().optional(),
  version: z.string().optional(),
});
const role = z.enum(["device", "terminal"]);
const pairStatus = z.enum(["waiting", "matched"]);
const errorCode = z.enum(["AUTH_FAILED", "WRONG_PARAM", "KICKED", "INTERNAL", "DEVICE_OFFLINE"]);
const authInit = z.strictObject({
  type: z.literal("auth_init"),
  device_sid: deviceSid,
  meta: meta.optional(),
  client_ts: unixSeconds.optional(),
});

export type WebRemoteControlRelayV2Role = z.infer<typeof role>;
export type WebRemoteControlRelayV2PairStatus = z.infer<typeof pairStatus>;
export type WebRemoteControlRelayV2ErrorCode = z.infer<typeof errorCode>;
export type WebRemoteControlRelayV2Meta = z.infer<typeof meta>;
export type WebRemoteControlRelayV2AuthInit = z.infer<typeof authInit>;

const pairStatusQuery = z.strictObject({
  type: z.literal("pair_status_query"),
  client_ts: unixSeconds.optional(),
});
const outgoingData = z.strictObject({
  type: z.literal("data"),
  payload: z.json(),
  client_ts: unixSeconds.optional(),
});
const outgoingMessage = z.discriminatedUnion("type", [authInit, pairStatusQuery, outgoingData]);
export type WebRemoteControlRelayV2PairStatusQuery = z.infer<typeof pairStatusQuery>;
export type WebRemoteControlRelayV2OutgoingData = z.infer<typeof outgoingData>;
export type WebRemoteControlRelayV2OutgoingMessage = z.infer<typeof outgoingMessage>;

export function parseWebRemoteControlRelayV2OutgoingMessage(
  value: unknown,
): WebRemoteControlRelayV2OutgoingMessage | null {
  const result = outgoingMessage.safeParse(value);
  return result.success ? result.data : null;
}

const authAck = z.strictObject({
  type: z.literal("auth_ack"),
  device_sid: deviceSid,
  terminal_sid: z.string().optional(),
  pair_status: pairStatus,
  server_ts: unixSeconds.optional(),
});
const pairStatusAck = z.strictObject({
  type: z.literal("pair_status_ack"),
  terminal_sid: z.string().optional(),
  pair_status: pairStatus,
  server_ts: unixSeconds.optional(),
});
const incomingData = z.strictObject({
  type: z.literal("data"),
  payload: z.json(),
  server_ts: unixSeconds.optional(),
});
const relayError = z.strictObject({
  type: z.literal("error"),
  code: errorCode,
  message: z.string().optional(),
  server_ts: unixSeconds.optional(),
});
const incomingMessage = z.discriminatedUnion("type", [
  authAck,
  pairStatusAck,
  incomingData,
  relayError,
]);
export type WebRemoteControlRelayV2AuthAck = z.infer<typeof authAck>;
export type WebRemoteControlRelayV2PairStatusAck = z.infer<typeof pairStatusAck>;
export type WebRemoteControlRelayV2IncomingData = z.infer<typeof incomingData>;
export type WebRemoteControlRelayV2Error = z.infer<typeof relayError>;
export type WebRemoteControlRelayV2IncomingMessage = z.infer<typeof incomingMessage>;

export function parseWebRemoteControlRelayV2IncomingMessage(
  value: unknown,
): WebRemoteControlRelayV2IncomingMessage | null {
  const result = incomingMessage.safeParse(value);
  return result.success ? result.data : null;
}

export const WEB_REMOTE_CONTROL_RELAY_V2_HTTP = {
  register: { method: "POST", path: "/api/v1/remote/device" },
  list: { method: "GET", path: "/api/v1/remote/device" },
  delete: { method: "POST", path: "/api/v1/remote/device/delete" },
  token: { method: "POST", path: "/api/v1/remote/token" },
} as const;
export const WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH = "/api/v1/remote/ws2";
export type WebRemoteControlRelayV2HttpOperation = keyof typeof WEB_REMOTE_CONTROL_RELAY_V2_HTTP;

const httpRequests = {
  register: z.strictObject({ device_mid: identifier }),
  list: z.strictObject({}),
  delete: z.strictObject({ device_sid: identifier }),
  token: z.strictObject({ role }),
};
// 服务端新增响应字段应向后兼容；z.object 校验已声明字段并剥离未知字段，嵌套对象同理。
const device = z.object({
  device_sid: deviceSid,
  device_mid: identifier,
  online: z.boolean(),
  created_at: unixSeconds,
  meta: z.object(meta.shape),
});
const token = z.object({
  // 16 字节无填充 Base64URL 的末字符只能使用高两位。
  token: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
  expires_in: z.number().int().positive(),
});
const httpError = z.object({
  code: z
    .number()
    .int()
    .refine((value) => value !== 0),
  msg: z.string(),
  data: z.null().optional(),
});
function response<T extends z.ZodType>(data: T) {
  return z.union([z.object({ code: z.literal(0), msg: z.string(), data }), httpError]);
}
const httpResponses = {
  register: response(device),
  list: response(z.array(device)),
  // Go Response.Data 带 omitempty：删除成功/失败可能省略 data。
  delete: response(z.null().optional()),
  token: response(token),
};
export type WebRemoteControlRelayV2Device = z.infer<typeof device>;
export type WebRemoteControlRelayV2Token = z.infer<typeof token>;
export type WebRemoteControlRelayV2HttpError = z.infer<typeof httpError>;
export type WebRemoteControlRelayV2HttpRequest<K extends WebRemoteControlRelayV2HttpOperation> =
  z.infer<(typeof httpRequests)[K]>;
export type WebRemoteControlRelayV2HttpResponse<K extends WebRemoteControlRelayV2HttpOperation> =
  z.infer<(typeof httpResponses)[K]>;

const requestSchemas: {
  [K in WebRemoteControlRelayV2HttpOperation]: z.ZodType<WebRemoteControlRelayV2HttpRequest<K>>;
} = httpRequests;
const responseSchemas: {
  [K in WebRemoteControlRelayV2HttpOperation]: z.ZodType<WebRemoteControlRelayV2HttpResponse<K>>;
} = httpResponses;

export function parseWebRemoteControlRelayV2HttpRequest<
  K extends WebRemoteControlRelayV2HttpOperation,
>(operation: K, value: unknown): WebRemoteControlRelayV2HttpRequest<K> | null {
  const schema: z.ZodType<WebRemoteControlRelayV2HttpRequest<K>> = requestSchemas[operation];
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseWebRemoteControlRelayV2HttpResponse<
  K extends WebRemoteControlRelayV2HttpOperation,
>(operation: K, value: unknown): WebRemoteControlRelayV2HttpResponse<K> | null {
  const schema: z.ZodType<WebRemoteControlRelayV2HttpResponse<K>> = responseSchemas[operation];
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** HTTP 错误只保留分类，避免 JWT、token URL 或服务端正文进入日志与 renderer。 */
export class WebRemoteControlV2ConnectionError extends Error {
  constructor(
    readonly reason: "auth-required" | "relay-unavailable",
    readonly retryable = false,
  ) {
    super(reason);
    this.name = "WebRemoteControlV2ConnectionError";
  }
}
