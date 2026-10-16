# Browser 命令契约 + BrowserControlPort + 协议方法规格（T3）

> 状态：已实现。
> 上位：`2026-07-07-browser-use-cdp-node-repl-spec.md`。
> 范围：定义跨 agent/协议/main 三处同源的 `BrowserCommand` 契约、agent 侧 `BrowserControlPort` 端口、以及 ZCode Protocol 的 `interaction/browserExecute` 方法。纯契约层，不含实现（broker/桥/CDP 在 T4/T5）。

## 1. 关键事实：@zcode/shared 单一来源

`apps/zcode-cli` 在**根 pnpm-workspace** 里，agent bootstrap 的 `@zcode/shared` 解析到**根 `packages/shared`**（与 app 同一个包）。故 `BrowserCommand` 与协议方法在 `packages/shared` 定义一次，agent 与 app 双方共用，天然无契约漂移。

## 2. BrowserCommand 契约（迁移复用）

- 落点：`packages/shared/src/browser-use/commands.ts`（从旧分支 `feat/in-app-browser-use` 迁移 `browserCommandSchema` 判别联合）。
- P0 核心子集：`navigate/back/forward/reload/snapshot/click/type/screenshot/getState`（旧的 fill/press/scroll/waitFor/capabilities 一并迁移保留，P0 只在 main 实现核心子集，其余 executor 返回 unsupported）。
- 同时迁移 `snapshot.ts`（`BrowserSnapshot`/元素 ref 结构，供 CDP AX 树输出）、结果类型 `BrowserCommandResult`。
- `packages/shared/src/index.ts` 导出 `browser-use/*`。

## 3. 协议方法 interaction/browserExecute

`packages/shared/src/zcode-protocol/index.ts`：
- `zcodeProtocolMethods` 加 `interactionBrowserExecute: "interaction/browserExecute"`（归 interaction/，agent→app 反向请求，非 session method）。
- 新增 schema（成对 + type）：
  ```ts
  zcodeBrowserExecuteParamsSchema = z.object({
    requestId: nonEmptyString,       // 关联
    sessionId: nonEmptyString,       // zcode session
    turnId: nonEmptyString.optional(),
    command: zcodeBrowserCommandSchema,   // 复用 browser-use/commands 的判别联合（在 protocol 内重声明或 import）
  }).strict();
  zcodeBrowserExecuteResultSchema = z.object({
    ok: z.boolean(),
    state: z.unknown().optional(),        // BrowserPageState
    snapshot: z.unknown().optional(),
    image: z.object({ base64: z.string(), mimeType: z.literal("image/png") }).strict().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
    elapsedMs: z.number().nonnegative(),
  }).strict();
  ```
  注意：protocol 文件历史上 schema 自包含，`zcodeBrowserCommandSchema` 直接在此定义（与 browser-use/commands.ts 同构，用 keep-in-sync 注释 + round-trip 测防漂移）；或从 browser-use/commands import。优先 import 复用。
- 契约表 `zcodeProtocolSessionMethodContracts` 加 `[interactionBrowserExecute]: { params, result }`。

## 4. BrowserControlPort（agent 侧端口）

- 落点：`apps/zcode-cli/packages/contracts/src/interfaces/browser-control.port.ts`（新），`interfaces/index.ts` 导出。
  ```ts
  export interface BrowserControlPort {
    execute(input: {
      sessionId: string;
      command: BrowserCommand;
      traceContext?: TraceContext;
      signal?: AbortSignal;
    }): Promise<BrowserCommandResult>;
  }
  ```
- `BrowserCommand`/`BrowserCommandResult` 类型来源：agent contracts 需要它们。由于 `@zcode/shared` 双方共用，contracts 可 `import type { BrowserCommand } from "@zcode/shared"`（确认 contracts 依赖 @zcode/shared；若不依赖则在 contracts 内定义镜像类型 + round-trip 测）。

## 5. Port 注入链（沿 executionPort 同路）

`browserControlPort` 完全仿 `executionPort` 全链透传：
- `ZCodeAppOptions`（`bootstrap/src/app/types.ts`）加 `browserControlPort?: BrowserControlPort`（可选，缺省则 agent.browsers 报 unavailable）。
- `create-app.ts` 把 `options.browserControlPort` 透传进 agent-runtime deps（仿 220/346/394/437 行 executionPort）。
- `ToolExecutionContext`（`core/src/tool/types.ts`）加 `browserControlPort?`；`call-runner.ts`/`impl.ts`/`agent-runtime.ts` 组装 context 时透传（仿 executionPort）。
- T6 的 node_repl handler 从 `context.browserControlPort` 拿到它，注入给 browser-client 的 `execute`。

## 6. 验证点（T3 单测）

- `browserCommandSchema` parse/reject（各 method + strict 拒多余字段）。
- `zcodeBrowserExecuteParamsSchema`/`ResultSchema` round-trip（构造→parse→一致）。
- 方法表存在：`zcodeProtocolMethods.interactionBrowserExecute === "interaction/browserExecute"`；契约表含该条目且 params/result 是 zod schema。
- 若 protocol 内 command schema 与 browser-use/commands 分别声明：一个 round-trip 测证明二者对同一对象解析一致（防漂移）。
- typecheck：ZCodeAppOptions/ToolExecutionContext 加字段后全链编译通过。
