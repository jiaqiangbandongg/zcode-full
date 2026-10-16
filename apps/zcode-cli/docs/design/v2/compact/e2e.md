# Compact E2E Harness

## 目标

Compact 需要一组可手动运行、可定时调度的 E2E，用来验证它不只在 mock runtime 中成立，也能穿过真实 provider adapter、tool loop、message projection、compact boundary 和 session event 链路。

这组 E2E 不进入默认 `npm test`，因为真实模型 case 需要外部网络、真实 API key 和模型费用。默认 CI 继续跑 mock/unit/integration；真实模型 E2E 由开发者本地、nightly 或发布前手动触发。难以稳定用真实 provider 诱发的错误路径使用 Docker 内本地 scripted OpenAI-compatible provider，仍然走真实 ZCode app、provider adapter 和 runtime 链路。

真实 provider case 会在同一进程中启动一个 OpenAI-compatible capture proxy。ZCode 临时配置里的 provider `baseURL` 指向容器内 `127.0.0.1`，proxy 记录请求/响应 payload 后再转发到真实 upstream。scripted provider case 则直接由容器内 HTTP server 生成 OpenAI-compatible 响应，并记录同样形态的 capture。这样抓包能力跟随 Docker E2E 自带，不依赖宿主机安装 Proxyman、mitmproxy 或 tcpdump。

## Case Matrix

### microcompact

Fixture 构造一个临时 workspace，包含 Node emitter script。runner 使用 `deepseek/deepseek-v4-flash`，提示模型必须调用两次 `Bash`：

- `node scripts/emit-alpha.mjs`
- `node scripts/emit-beta.mjs`

两个 script 会写入临时 marker file，并打印带不同 sentinel 的大 stdout。这比纯 `Read` 更接近 Docker 中真实 coding agent 的可读写工具压力，同时不会改动仓库本身。

Runtime 以测试注入方式启用 local microcompact：

- `microcompact.enabled = true`
- `thresholdTokens = 1`
- `keepRecentToolResults = 1`
- `compactableToolNames = ["Bash"]`
- full auto compact threshold 设置得更高，避免 E2E 混入 summary compact

验收：

- capture 至少记录到一次 provider `/chat/completions` 请求。
- 至少发生两个 `ToolCallResult`。
- 至少发生一个 `microcompact_boundary`。
- 没有发生 full `compact_boundary`。
- 最后一次 `model_request` 的上下文包含 microcompact 占位符。
- 最后一次 `model_request` 只保留两个 Bash 结果中最近一次的原始 sentinel。
- 最终 assistant response 包含固定完成标记。

### manual-full-compact

真实模型先执行两个普通文本 turn，再执行 `/compact`，最后继续一轮对话。验收重点不是逐字校验 summary，而是校验 full compact 的结构化边界：

- 产生 `compact_boundary`。
- `trigger = manual`，`phase = standalone_turn`。
- summary model request 的 `querySource = compact`，`toolCount = 0`。
- 用户自定义 compact 指令进入 summary request。
- compact 后的下一轮 provider-visible context 包含 post-compact continuation summary。

### auto-full-compact

真实模型执行一次大 stdout `Bash`，runtime 配置一个很低的 auto compact threshold，并禁用 microcompact，确保工具结果返回后的下一次 model step 前触发 full compact。验收：

- 至少一个 `ToolCallResult`。
- 产生 `compact_boundary`。
- `trigger = auto`，`phase = mid_turn`。
- final response 包含固定完成标记。

### compact-ptl-retry

Docker 内 scripted provider 在第一次 compact summary request 返回 OpenAI-compatible `context_length_exceeded`，第二次返回 summary。验收：

- compact request 至少出现两次。
- 第二次 request 带 `compactPromptTooLongRetry = 1`。
- capture 中同一个 compact case 有 400 和 200。
- 最终仍产生标准 `compact_boundary`。

### reactive-compact

Docker 内 scripted provider 在普通 turn 的主请求返回 `context_length_exceeded`，runtime 触发 reactive compact 并重放本轮请求。验收：

- 产生 `compact_boundary`。
- `trigger = reactive`，`phase = reactive`，`compactReason = provider_overflow`。
- capture 中包含主请求的 400 overflow。
- retry 后 final response 包含固定完成标记。

## Artifact 布局

定时任务应以顶层 `result.json` 作为机器判定入口：

```text
result.json
capture.json
events.json
cases/
  microcompact/
    capture.json
    events.json
    result.json
  manual-full-compact/
    capture.json
    events.json
    result.json
  ...
```

顶层 `result.json` 只保存 suite/case summary；每个 case 的完整 provider capture 和 runtime events 放在 `cases/<case>/` 下。顶层 `capture.json` 和 `events.json` 是索引文件，便于定时任务上传或归档时发现每个 case 的日志路径。

## 暂不纳入 passing E2E 的规划项

`session memory compact`、`partial compact`、compact 后自动恢复最近文件目前仍是 plan 中明确的后续能力，不应伪装成已通过的定时 case。当前定时套件只覆盖第一批已实现主路径：manual full compact、auto compact、PTL retry、reactive compact 和 provider-neutral local microcompact。等这些能力落地后，必须先扩展本 spec，再新增 passing E2E。

## 配置边界

E2E 使用既有 `ZCODE_API_KEY` 作为 API key fallback，不新增新的 `ZCODE_` 环境变量。DeepSeek base URL 和 model id 默认写在 runner/config fixture 中，也可以通过 runner CLI 参数覆盖；这些覆盖只影响 E2E 进程，不进入产品配置层。scripted provider case 使用临时 fake provider 配置，`apiKeyRequired = false`，不读取真实 API key。

Docker runner 以仓库根目录为 build context，在容器内执行 `pnpm install`、`pnpm build` 和 E2E runner。默认基础镜像是 `node:24.14-alpine`，也允许通过 Docker build arg 覆盖为本地镜像或企业镜像源；npm registry 同样只通过 Docker build arg 覆盖，避免新增产品环境变量。`@mbears` scope 默认回到 npm 官方源，防止通用镜像源没有同步 scoped package。镜像可通过 `INSTALL_CA_CERTIFICATES=true` 安装系统 CA；如果当前网络或 provider 需要宿主机额外信任的根证书，运行容器时通过 Node 标准 `NODE_EXTRA_CA_CERTS` 挂载 CA 文件，不关闭 TLS 校验。容器只接收必要 API key，不挂载用户主目录或全局 ZCode 配置。
