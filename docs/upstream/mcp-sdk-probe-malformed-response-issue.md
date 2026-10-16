# Upstream issue draft: @modelcontextprotocol SDK — probe classifier treats a malformed HTTP 200 error body as a hard network failure instead of legacy evidence

> 状态：草稿（尚未提交给 modelcontextprotocol/typescript-sdk）。
> 日期：2026-08-25。
> 影响包：`@modelcontextprotocol/client` 2.0.0。
> 关联：`docs/mcp-dual-era-version-negotiation.md`（ZCode 侧不改协商语义，只做
> `protocol_negotiation_failed` 失败引导 + `protocolVersion: "legacy"` 兼容开关）。

以下为英文 issue 正文草稿。

---

## Title: Version negotiation probe: HTTP 200 + malformed JSON-RPC error body hard-fails as network error, while the same body with a 4xx status is correctly classified as legacy evidence

### Description

**Package / version:** `@modelcontextprotocol/client` 2.0.0

**Summary.** In dual-era (`auto`) version negotiation over Streamable HTTP, a server that answers the `server/discover` probe with **HTTP 200 and a JSON-RPC error body that fails `JSONRPCMessageSchema`** causes the probe to hard-fail with `SdkError(SdkErrorCode.EraNegotiationFailed)` via the network-error branch. The **exact same body delivered with a 4xx status code** flows through `classifyHttpError` → `parseJsonRpcErrorBody` and is correctly treated as legacy evidence (fallback to `initialize` when available). The classification is asymmetric with respect to the HTTP status line, even though the meaningful signal is in the body.

**Real-world repro.** At least one widely deployed non-conforming legacy server (Feishu Project MCP) answers unknown methods — including `server/discover` — with:

```http
POST /mcp HTTP/1.1
...
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"invalid request"}}
```

`id: null` does not pass `JSONRPCMessageSchema` (a JSON-RPC error response must carry a request id of type string/number). The transport-level schema parse failure is caught by `normalizeReply`, which has no better bucket for it than the network-error branch, so the probe outcome becomes a hard failure: `SdkError(EraNegotiationFailed, "Version negotiation probe failed: ...")`.

This server is clearly not a modern server: a malformed envelope can never be a *recognized modern error* (those are well-formed per spec). It is a legacy server with a non-conforming error response — exactly the population the dual-era fallback exists for. With this behavior, `auto` mode cannot connect to it at all; users must know to pin `protocolVersion: "legacy"` by hand.

**Why the asymmetry is wrong.**

- 4xx + the same unparseable body → `classifyHttpError` → `parseJsonRpcErrorBody` → parse failure is not modern evidence → legacy fallback (when available).
- 200 + the same unparseable body → transport send/parse error → `normalizeReply` network-error branch → hard `EraNegotiationFailed`, no fallback.

The only difference is the status code, and 200-with-garbage is *stronger* evidence of "not a modern server" than 404-with-garbage: a modern server must return a schema-valid response or a recognized modern error to `server/discover`. A body that cannot even be parsed as a JSON-RPC message cannot be a recognized modern error.

**Suggested fix.** Inside the probe window, classify schema-parse failures of the `server/discover` send/reply separately from genuine transport failures: introduce a distinct probe outcome (e.g. `malformed-response`) and treat it as legacy evidence when a legacy fallback is available — mirroring the existing `classifyHttpError` → `parseJsonRpcErrorBody` degradation path for 4xx. Genuine network conditions (connect errors, timeouts, TLS failures, connection reset before any byte) should keep failing the probe as they do today; only "we got an HTTP response but its body is not a valid JSON-RPC message" changes bucket.

We are happy to turn this into a PR with tests if the maintainers agree with the classification change.

### Steps to reproduce

1. Start any HTTP endpoint that answers every POST with `200` and the body above.
2. Connect with `Client` in `auto` negotiation mode (`StreamableHTTPClientTransport`).
3. Observe `client.connect()` rejects with `SdkError(SdkErrorCode.EraNegotiationFailed)` ("Version negotiation probe failed: ...") — no legacy fallback is attempted.
4. Re-run with the same handler returning `404` (same body). The probe now classifies the response as legacy evidence and the client falls back to `initialize` (when a pre-2026-07-28 version is supported).
