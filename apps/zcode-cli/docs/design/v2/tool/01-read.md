# Read Tool

## 定位

`Read` 读取本地文件系统中的文件，覆盖文本、图片、视频和 PDF；Jupyter Notebook 是后续实现项。

## 输入契约

`Read` 输入是严格对象：

| 字段        | 类型     | 必填 | 说明                                                                                  |
| ----------- | -------- | ---- | ------------------------------------------------------------------------------------- |
| `file_path` | `string` | 是   | 要读取的路径；相对路径按 session cwd 解析，绝对路径会规范化后直接交给文件系统 adapter |
| `offset`    | `number` | 否   | 从第几行开始读取，非负整数。默认从 `1` 开始                                            |
| `limit`     | `number` | 否   | 读取多少行，正整数                                                                    |
| `pages`     | `string` | 否   | PDF 页码范围，例如 `1-5`、`3`、`10-20`；单次最多 20 页                                |

设计要求：

- 对模型提示必须明确 `file_path` 可使用绝对路径或相对 session cwd 的路径；运行时统一规范化为绝对路径。模型侧应优先使用用户提供的绝对路径或已经解析出来的绝对路径，避免路径歧义。
- `offset`、`limit` 只用于大文件或已知目标范围。`offset` 采用模型可见行号语义：`0` 和 `1` 都表示从第 1 行开始；adapter 内部再转换为零基行偏移。
- 未显式传 `limit` 时，默认最多读取前 `2000` 行；显式传 `limit` 时读取 `limit` 行。
- 只有当前 turn 的模型明确 `supportsPdf=true` 时，provider-visible schema 和 executor schema 才同时包含 `pages`；`false` / `undefined` 保持既有 Read shape，不接受该字段。
- PDF `pages` 支持单页 `N`、闭区间 `N-M` 和开放尾区间语法 `N-`。页码从 1 开始；单次最多 20 页，因此开放尾区间会按“超过 20 页”拒绝，而不是在本地扩成任意上限。
- 模型提示必须明确：当用户提供图片、截图或支持的图片路径时，必须优先使用 `Read`，不要用 `Bash` 读 base64、调用 `file`/`identify` 或写临时脚本来代替视觉读取。`Bash` 只用于列目录、查找路径或处理当前 `Read` 不支持的文件类型。
- 当前实现支持文本、常见图片（`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`）、视频（`.mp4`、`.m4v`、`.mov`、`.webm`、`.mkv`、`.avi`）和按模型能力条件开放的 PDF。Jupyter Notebook、SVG 和 device path 仍是后续实现项；未实现的能力不得写入 provider-visible prompt。

## 输出契约

输出是按 `type` 区分的 union（`notebook` 为后续实现项）：

| `type`           | 内容                                                         |
| ---------------- | ------------------------------------------------------------ |
| `text`           | `filePath`、`content`、`numLines`、`startLine`、`totalLines` |
| `image`          | base64 图片、MIME type、原始大小、可选尺寸信息               |
| `video`          | base64 视频、MIME type、原始大小                             |
| `notebook`       | notebook 路径和 cells                                        |
| `pdf`            | PDF 路径、base64、原始大小                                   |
| `parts`          | PDF 页面提取结果、输出目录、页数、原始大小                   |
| `file_unchanged` | 文件路径。表示同一范围此前已读且未变化                       |

模型可见结果不是简单 JSON：

- 文本内容必须通过专用模型可见序列化输出，不能走通用 `JSON.stringify(output)`。
- 文本内容会加行号，格式类似 `cat -n`，当前 provider-visible 格式为 `<lineNumber>\t<fileContentLine>`。
- 行号和第一个 tab 是 Read 视图前缀，不属于文件内容；第一个 tab 之后的所有字符，包括额外 tab 和空格缩进，才是后续 `Edit.old_string` 应复制的真实内容。
- 文本读取结果是 filesystem adapter 解码后的 Unicode 逻辑文本。adapter 必须自动识别 UTF-8、UTF-16LE 以及常见中文 legacy 编码（GB2312 / GBK / GB18030），并把原始编码保存在 metadata 中供后续 mutation tool 保真写回；模型不需要也不应该通过 shell 或脚本转码后再编辑。
- 为兼容历史 session、日志回放和模型缓存，`Edit` 行号前缀剥离必须同时接受 `<lineNumber>\t<fileContentLine>` 和 `<lineNumber>: <fileContentLine>`；当前 `Read` 输出使用前者以保持 provider-visible 基线一致。
- 成功读取非空文本后，provider-visible tool result 只包含按条件生成的 freshness / truncation reminder 和带行号正文，不追加 malware reminder 之类的历史后缀。
- 用户提交的文本文件附件会合成 `Called the Read tool...` 与 `Result of calling the Read tool...` reminder。同一附件的 reminder body 使用单换行连接；不同附件在同一个 mid-conversation system turn 中仍使用双换行。附件超过默认行数上限时，提示必须明确截断到前 `2000` 行，并提示按需继续读取该文件。
- 空文件返回 system reminder。
- 文本结构化输出应携带原始文件大小、实际读取字节数、是否截断等 metadata，供 UI/ZCode app-server/debug 展示；模型可见文本仍只展示行号内容或可操作错误。
- 图片转成 provider-visible image content block。对 Anthropic wire format，
  `Read` 图片结果必须落到对应 tool result 的 `content` 数组里，例如
  `{ type: "image", source: { type: "base64", data, media_type } }`，而不是
  把 `{ type: "image", base64, mimeType }` JSON 字符串塞进 `tool_result.content`。
  在 AI SDK 边界，等价内部形态是
  `output: { type: "content", value: [{ type: "image-data", data, mediaType }] }`。
- 图片 tool result 的 provider-visible `content` 只包含媒体 block。即使图片经过缩放，原始尺寸、展示尺寸和坐标换算比例也只保留在结构化 output，不额外插入 text block，避免图片结果形态随 resize 与否漂移。
- 对 OpenAI-like chat providers（`openai`、`openai-compatible`、`gateway`），
  AI SDK 会把 tool result 的 structured `content` JSON 序列化成文本；因此
  `Read` 图片结果在 provider adapter 边界必须拆成短文本 tool result 占位符
  和随后一条合成 user media message。合成 user message 必须出现在连续
  tool-result 消息之后，避免打断 OpenAI tool call / tool result 配对。
- 图片 payload 是模型请求期的结构化媒体内容；session event、DB tool output、
  TUI/debug 展示只应保存短文本摘要或 artifact 引用，不应持久化 base64 图片文本。
- 视频结果不转码、不压缩，以 provider-neutral video block 投影；provider adapter 再按 endpoint 转成 `video_url` 或 video source。tool result 无原生 video part 时，保持短文本 tool result，并在连续 tool-result 块后追加合成 user media message。
- Read 的成功结果如果全部由 data-backed image/video/file block 组成，完整媒体 snapshot 必须写入
  artifact store，并按原顺序记录在对应 `ToolStateCompleted.attachments`；`completed.output` 仍只保留
  短文本摘要。冷恢复和会话内模型切换都从 attachment artifact 重建 provider-neutral block，
  再由当前 provider 投影为 base64 wire，不能把单次请求 payload 当成 DB 事实源。
- notebook 转成 notebook cell tool result。
- PDF 未传 `pages` 时作为原生 `application/pdf` file block 注入；传 `pages` 时返回固定摘要和按页码升序排列的 JPEG 页面图片。
- 重复读取未变化文件时返回固定 stub，让模型引用上下文里此前的读取结果。

ZCode 需要把内部结构化输出和模型可见序列化分开，避免 UI、SDK、provider 三者耦合。

## PDF 执行与结果契约

PDF 执行不内置 Poppler，也不引入 Python、PDFium、Pillow、PDF.js 或额外 fallback。provider-visible 文案以本节列出的固定文案为逐字基线。`PdfDocumentPort` 只负责外部命令 I/O；core 负责能力判断、页码语义、文件预算和模型结果组装。

```text
Read(file_path=.pdf)
        |
        +-- current turn supportsPdf !== true --> 原 Read schema / 原文本分支
        |
        +-- supportsPdf === true
              |
              +-- pages omitted
              |     +-- pdfinfo best effort (10s)
              |     +-- known pages > 10 --> 要求 pages
              |     +-- <= 20MiB + %PDF- magic --> native PDF block
              |
              +-- pages present
                    +-- supportsImages === false --> <tool_use_error>
                    +-- validate N / N-M / N- and <= 20 pages
                    +-- pdftoppm -jpeg -r 100 (120s, PATH)
                    +-- existing image preparation per page
                    +-- summary text + ordered page images
```

### 依赖与进程边界

- `pdfinfo` 和 `pdftoppm` 直接通过 `ExecutionPort` 以 executable + argv 启动，禁止拼接 shell 字符串。
- Poppler 只从运行环境 `PATH` 解析。ZCode 不下载、不编译、不随 Desktop / SEA / remote runtime 打包 Poppler。
- `pdfinfo` 只在未传 `pages` 时尽力探测总页数，超时 10 秒；普通执行或解析失败不阻止后续原生 PDF 读取，但 runtime shutdown 或用户取消产生的 `cancelled` 必须沿 tool executor 取消路径向上冒泡。
- `pdftoppm` 先用 `-v` 做 5 秒可用性检查，再以 `-jpeg -r 100` 渲染；探测结果为 `exitCode=0`，或 `exitCode!=127` 且 stderr 非空时视为可用。缺少命令时逐字返回 `pdftoppm is not installed. Install poppler-utils (e.g. \`brew install poppler\` or \`apt-get install poppler-utils\`) to enable PDF page rendering.`。子进程渲染超时为 120 秒。只有 PDF `pages` 分支使用 150 秒的 Read executor 外层预算，为可用性检查、页面图片规范化和临时目录清理留出空间；其他 Read 调用仍为 30 秒。只缓存成功的可用性检查，避免安装 Poppler 后必须重启进程。
- 页面渲染使用唯一临时目录，并在成功、失败、取消和超时后统一清理。临时目录的创建、枚举和页面读取失败统一映射为 `io_error`；清理失败不得覆盖已有的 Poppler 主错误。单次最多 20 页，因此可以在渲染完成后并行读取页面文件，不引入 600 页流式协议。

### 文件和页码边界

- 未传 `pages` 的原生 PDF 最大 `20MiB`；先验证普通文件、非空和 `%PDF-` magic。
- 传 `pages` 的页面提取输入最大 `100MiB`；`offset` / `limit` 对 PDF 不生效。
- 已知总页数超过 10 且未传 `pages` 时返回明确错误，提示使用 `pages`；一次请求最多 20 页。
- PDF `pages` 的语法与 20 页上限必须在 Read `validateInput` 阶段、PreToolUse Hook 和权限检查之前完成。非法语法使用 `errorCode=7` 和固定文案；超过 20 页使用 `errorCode=8` 和固定文案；executor 统一投影为 `<tool_use_error>`，handler 不自行拼接错误 envelope。
- 以下文件错误使用固定文案并逐字保持：非普通文件使用 `Path is not a regular file: <path>`；原生 PDF 超过 20MiB 使用 `PDF file exceeds maximum allowed size of 20MB.`；分页提取输入超过 100MiB 使用 `PDF file exceeds maximum allowed size for text extraction (100MB).`；缺失 `%PDF-` magic 使用 `File is not a valid PDF (missing %PDF- header): <path>`。能力组合、依赖注入、取消和临时目录 I/O 使用本地稳定错误。
- `pdftoppm` 的 `Wrong page range given` 必须映射成包含文档总页数和合法范围的明确错误；其中 `last page (0)` 映射为 `corrupted` 并返回空 page tree 的明确文案。输入侧只识别 Poppler 明确的 `I/O Error:` / `Permission Error:`；密码保护只按 stderr 中的 `password` 诊断识别；损坏只按 `damaged` / `corrupt` / `invalid` 或已知的 trailer/xref 结构错误识别。进程成功但没有生成页面图片也映射为明确的 `corrupted`；未识别的 stderr 使用 `process_failed`，缺少 Poppler、取消和超时使用各自的稳定错误。
- `PdfDocumentPortError` 到 Read tool error code 的映射由 core 单点维护：`unavailable -> PDF_CONFIGURATION_ERROR`、`corrupted -> PDF_INVALID`，超时、密码保护、页码越界、权限、通用 I/O 和未知进程失败分别使用独立的 `PDF_*` error code；取消继续走 executor 的取消路径，不能降级成业务错误。
- `pages` 只对 `.pdf` 生效；兼容调用把 `pages` 传给非 PDF 时，不得改变普通 Read 的既有行为。

### Provider-visible tool result

- 未传 `pages`：`PDF file read: <filePath> (<size>)`，并携带原生 PDF file block。
- 传 `pages`：`PDF pages extracted: <count> page(s) from <filePath> (<size>)`，随后是按原始页码升序排列的页面图片。
- 文件大小使用一位小数、去除尾随 `.0` 的格式，例如 `1536 bytes -> 1.5KB`、`2048 bytes -> 2KB`。
- 不生成 `<Page_N_image>`、`<Page_N_parse_result>`、文本层、PNG 或 120 DPI，也不保留旧的 600 页语义。
- Anthropic Messages 和 OpenAI Responses 保留结构化 text/media tool result。OpenAI Chat Completions 沿用 ZCode 既有通用投影：`role: tool` 包含上述摘要和逐页图片文本占位符，实际页面图片按原顺序进入紧随连续 tool-result 消息之后的一条 synthetic user message；PDF 不增加专属占位符抑制规则。
- live、resume、fork 和冷启动通过现有 tool media artifact + `modelContentLayout` 恢复同一顺序，不新增 PDF 专属 manifest 或持久化协议。
- E2E 必须从真实 runtime 发起 `Read` tool call，并由本地 provider capture endpoint 断言最终 OpenAI Chat Completions HTTP body；测试不得直接调用消息转换 helper。首次 tool-result 请求与重新创建 runtime 后的 cold-resume 请求必须包含相同的摘要和同序页面图片 data URL，以覆盖 executor、artifact 持久化、历史恢复及 provider serialization 的完整链路。
- `supportsPdf` 与 `supportsImages` 独立：无 `pages` 的原生 PDF 只依赖 `supportsPdf`；有 `pages` 且模型明确不支持图片时，在任何 Poppler I/O 前返回统一 tool error。
- Read 图片、PDF 页面图片、原生 PDF 和视频共用 `40MiB` 请求媒体聚合预算，按完整
  data URL 字节数计量；单个视频仍须满足 `30MiB` 原始文件上限。不增加
  PDF 专属预算或豁免。预算只作用于当前 provider request 副本，并继续使用既有的
  最新用户媒体优先、历史媒体按新近程度保留和稳定 placeholder 语义。

## 行为语义

核心流程：

1. 按 session cwd 展开相对路径并规范化为绝对路径。
2. 当前版本不硬拒绝 workspace 外路径，只保留绝对路径规范化；后续由 filesystem permission adapter 接管工作区外读写的 ask/deny 策略。
3. 校验 PDF 页码范围。
4. 进行权限 deny 规则和特殊路径校验。
5. 按类型选择读取策略。
6. 对文本和 notebook 进行 token/size 限制。
7. 文本文件由 `FileSystemPort` 统一完成 bytes 到 Unicode 的解码、LF 规范化、原始 `encoding` 和 `lineEndings` 记录；无法可靠判定为文本或包含混合/不支持编码时返回稳定 `unsupported` 错误，不向模型展示乱码。
8. 记录 `readFileState`，用于后续 `Edit` 和 `Write` 的读前写入保护。
9. 对同一文件同一范围重复读取做 dedup，如果 mtime 未变，返回 `file_unchanged`。
10. 对图片和 PDF 提取页复用现有尺寸、API byte budget 和 token budget 压缩。
11. 对视频做格式识别和 `30MiB` 输入上限校验，不做转码或压缩。
12. 对大 PDF 要求分页读取或走页面提取。

### 视频预算

- `READ_VIDEO_MAX_INPUT_BYTES = 30 * 1024 * 1024`，按原始字节校验。
- 支持 MP4、M4V、MOV、WEBM、MKV 和 AVI；扩展名到 MIME 的映射与 prompt 附件解析共用同一事实源。
- 超限文件返回稳定错误；model-I/O 记录必须脱敏 video base64 正文。

### 图片预算与压缩

ZCode 的图片 `Read` 采用多阶段保护策略，最长边使用
`2000px` 上限：

- `READ_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024`。这是 provider/API 侧
  base64 payload 硬上限，校验对象是 base64 字符串长度，不是原始 bytes。
- `READ_IMAGE_TARGET_BYTES = READ_IMAGE_MAX_BASE64_BYTES * 3 / 4`。这是默认 raw
  bytes target，约 `3.75MiB`，用于在 base64 膨胀前留出安全空间。
- `READ_IMAGE_MAX_DIMENSION = 2000`。图片最长边超过该值时按比例缩小，不放大
  小图。
- `READ_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024`。超过该输入大小的图片在读取
  bytes 前返回稳定错误，避免把超大媒体读入内存。
- 空图片必须返回稳定错误，不允许发送空 base64 给 provider。
- 图片 MIME 以 magic bytes 检测为准，扩展名只作为进入图片路径和未知格式时的
  fallback。
- 如果原图 raw bytes、base64 bytes 和尺寸均在预算内，保留原始 bytes。
- 如果只超大小但未超尺寸，优先尝试保留格式压缩；PNG 优先优化/减色，JPEG/WebP
  逐步降低质量；仍失败时再转 JPEG。
- 如果超尺寸，先限制到 `2000px` 内，再重复格式保留、PNG 优化、JPEG 质量阶梯和
  更小尺寸兜底压缩。
- Read 还要用 `ceil(base64.length * 0.125)` 估算图片对模型输出预算的消耗；超过
  `READ_MAX_OUTPUT_TOKENS` 时，按 `maxBytes = floor((maxTokens / 0.125) * 0.75)`
  继续压缩。
- 图片输出携带原始尺寸、展示尺寸、原始 bytes、转换后 bytes、是否压缩、是否缩放
  和压缩策略。这些信息只属于结构化 output；模型可见内容始终只包含图片媒体 block，
  不因是否发生缩放而追加文字。

当前 Node/SEA 默认 adapter 仍使用纯 JS Jimp，以保持跨平台打包路径稳定。Jimp
无法重新编码 WebP；WebP 在预算内保持原样，超过预算时返回稳定可恢复错误。后续若
引入 optional sharp/native 或 WASM WebP 处理，需要先更新本 spec 的打包、降级和
测试策略。

### 文本大文件预算

ZCode 文本 `Read` 使用两层预算：

- `READ_MAX_FILE_SIZE_BYTES = 256 * 1024`。未显式传 `limit` 时，adapter 先按文件总大小检查；超过上限时返回 `too_large` / `read_file_too_large` 类错误，提示使用 `offset` 和 `limit`。
- 显式传 `limit` 时，不用文件总大小拦截，而是按完整文件的真实行区间读取。实现不能先读文件头部再在 core 中切片，否则会导致大文件后半段永远不可读。
- `READ_MAX_OUTPUT_TOKENS = 25_000`。范围读取后的选中内容仍要做模型输出预算校验；超过上限时返回 `read_output_too_many_tokens`，提示缩小范围。
- `READ_DEFAULT_MAX_LINES = 2000`。未显式传 `limit` 且文件大小通过检查时，最多返回前 `2000` 行。
- `resultBudget` 是最后兜底，不是正常路径。正常情况下 `Read` 自己应返回可操作错误或真实范围内容，不依赖 executor 截断巨大输出。

## 权限模型

`Read` 是只读且并发安全，但仍需要路径权限：

- explicit read deny 最高优先级。
- explicit read ask 先于隐式 allow。
- edit 权限可以隐式允许 read，但不能绕过 read deny/ask。
- 工作区内读取默认允许。
- session memory、plan、tool results 等内部可读路径可以允许。
- 工作区外读取当前版本不在 core path-policy 层拦截；后续默认 ask，并建议增加 session read rule。

ZCode 应将路径权限做成统一 filesystem permission adapter，`Read` 只声明 `getPath` 和操作类型 `read`。

## 校验与错误

失败路径包括（部分待补齐，见实现状态）：

- 无效 PDF 页码范围。
- PDF 页码范围超过单次最大页数。
- 路径命中 deny 规则。
- UNC 路径需要权限确认，避免 Windows NTLM 泄露。
- 二进制文件且不是 PDF、图片或 SVG。
- 会阻塞或无限输出的 device path，例如 `/dev/zero`、`/dev/stdin`。
- 文件不存在时附带 cwd 和相似文件建议。
- 文本或 notebook 超过 size/token budget。
- 视频超过 `30MiB` 输入上限。
- 大 PDF 未指定 pages。
- 文本编码不支持、疑似二进制或检测到混合编码时返回稳定 `unsupported` 错误，避免把乱码交给后续 `Edit.old_string` 匹配。

这些错误应保留稳定错误码和结构化原因，CLI 入口层再格式化成人类提示。

## ZCode 设计结论

## 实现状态（2026-05-08）

| 能力                               | 状态        | 说明                                                                                                                                                                       |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基本文本读取                       | implemented | 当前 `Read` 已通过 `FileSystemPort.readTextFile` 读取文本并支持 `offset` / `limit`。                                                                                       |
| 相对路径按 session cwd 解析        | implemented | 当前路径解析不依赖宿主进程 cwd。                                                                                                                                           |
| workspace 外路径硬拦截             | disabled    | 当前版本只规范化路径，不在 core path-policy 拒绝工作区外读取；原因是 subagent 需要读取用户指定的外部仓库或文件，细粒度 ask/deny 后续收敛到 filesystem permission adapter。 |
| 图片读取                           | implemented | 已支持常见图片格式和 resize adapter。                                                                                                                                      |
| PDF 原生读取与分页提取             | implemented | `supportsPdf` 条件 shape；原生 PDF 或 PATH Poppler JPEG 页面提取，单次最多 20 页；与图片、视频共用 `40MiB` 编码后请求媒体预算。                                       |
| 视频读取                           | implemented | 支持 MP4、M4V、MOV、WEBM、MKV、AVI；最多 `30MiB`，无转码/压缩，结果按 provider-neutral video block 投影。                                                                  |
| 模型可见行号格式                   | implemented | 当前文本输出通过 `formatModelContent` 转成 cat-n 风格 `<lineNumber>: <content>`，避免 JSON 转义污染 `Edit.old_string`；`Edit` 仍兼容旧的 `<lineNumber>\t<content>` 输入。  |
| readFileState                      | missing     | 当前 `Read` 尚未记录完整 read cache，后续 `Edit` / `Write` 不能判断未读、partial read 或 stale mutation。                                                                  |
| 重复读取 dedup                     | missing     | 尚未返回 `file_unchanged` stub。                                                                                                                                           |
| 文件类型、device path 和大文件保护 | partial     | 当前已实现文本大文件 `256KB` 总大小保护、真实范围读取和 `25_000` token 输出保护；二进制和 device path 失败路径仍待补齐。                                                     |

后续优先级：保留文本大文件与 read cache 既有语义；PDF 不在 Read handler 内叠加媒体
预算特殊兜底，共享请求媒体策略继续由 runtime provider-request 投影边界统一维护。

`Read` 是文件工具链的状态基础。ZCode 应把它建成 `FileReadService` 加 `ReadTool` 两层：

- `ReadTool` 负责 schema、权限、tool result 序列化。
- `FileReadService` 负责类型识别、范围读取、内容预算、read cache 更新。
- 文件系统 I/O 必须通过 `FileSystemPort`。
- `FileSystemPort` 可由本地 Node adapter 或远程/ZCode protocol client adapter 实现；Read tool 不得直接 import `fs/promises`。
- PDF、图片、notebook 处理应是可替换 adapter，避免核心 tool 直接依赖具体库。
- `readFileState` 必须记录 `path`、`mtime`、`content`、`offset`、`limit`、是否 partial view。
- 所有读取和 cache 命中都要带 `traceId`，便于回放和审计。
