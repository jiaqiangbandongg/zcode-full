# MCP Apps 常见资源 MIME 白名单

## 目标与边界

插件页面通过 `resources/read` 读取 PDF 等常见文件时，已有白名单会在返回页面前拒绝合法内容。本次扩展共享白名单的明确条目，保留现有匹配规则和资源边界；不使用 `application/`、`image/` 等新增大类前缀。

唯一规则来源为 `packages/shared/src/mcp-apps/resourceMime.ts`，继续由 `contract.ts` 导出 `MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST` 等原有接口。列表独立存放以保持主契约的行数边界。Agent 的 mcp-ui 执行检查；服务桥和插件页面不另建白名单。

```text
插件页面 → 实例凭证与服务器归属检查 → MCP resources/read
         → MIME 白名单与 8 MiB 总量检查 → 去除 _meta → 返回页面
```

## 接纳范围

| 类别       | 接纳的常见格式                                     |
| ---------- | -------------------------------------------------- |
| 已有类型   | `text/*`、JSON、PNG、JPEG、WebP、GLB、通用二进制   |
| 文档       | PDF、RTF、DOC/XLS/PPT、DOCX/XLSX/PPTX、ODT/ODS/ODP |
| 结构化数据 | XML、YAML（含 `application/x-yaml`）               |
| 图片       | SVG、GIF、AVIF、BMP、TIFF、ICO、HEIC、HEIF         |
| 音频       | MP3、MP4 音频、Ogg、WAV、WebM 音频、AAC、FLAC      |
| 视频       | MP4、WebM、Ogg、QuickTime、MPEG                    |
| 归档       | ZIP、GZIP、TAR、7z、RAR                            |
| 字体与模型 | WOFF、WOFF2、TTF、OTF、JSON glTF                   |

MIME 忽略大小写、首尾空白和分号后的参数；除此之外精确匹配。保留已有 `text/` 前缀行为。WAV、GZIP、ICO 的常见 MIME 别名显式列出，不推断任意扩展名或厂商类型。

## 保持不变

- 未列出的 MIME、空 MIME、没有 MIME 的 blob 仍拒绝；明确声明的 `application/x-msdownload` 等可执行类型不新增放行。
- 每次结果按全部内容项的 UTF-8 文本和 base64 解码字节累计，最多 8 MiB；超限整次拒绝，不截断。
- 保留实例凭证、服务器归属、失效实例、沙箱、CSP 和下载保存确认的现有检查。
- 仅传输资源，不保证宿主或插件具备对应格式的解码器；资源 `_meta` 不透传给页面。
- 不修改界面、重载按钮、握手或生命周期。不改变 desktop continuous 与 mobile replayable 的语义；Web/远程不可用时仍沿用原有能力边界。

## 回归验证

- 共享契约：常见类别接纳；大小写与参数兼容；未知类型、伪造后缀和可执行类型拒绝。
- Agent 处理器：PDF blob 与 SVG text 原样返回并去除 `_meta`；总大小、缺失 MIME 和服务器归属继续生效。
- Electron 集成：真实插件 iframe 经 App SDK、宿主、Agent 和 MCP 进程读取 PDF/SVG，核对 MIME 与字节；未知类型失败后页面仍可继续读合法资源。
- 使用已有 `mcp-apps-host-e2e.mjs --managed-only` 验证受控 Electron 链路，不将此结果表述为所有桌面平台或手机 Web 的完整回归。
