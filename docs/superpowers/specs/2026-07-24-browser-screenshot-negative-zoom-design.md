# Windows 负缩放与 Fit 下 Browser Use 截图 raster surface 修复设计

日期：2026-07-24
状态：已按 Windows Electron 运行时证据修正并实现

## 1. 问题与更正后的运行时证据

Windows Desktop 全局缩放为 `-2`（factor `0.826446...`）时，第一次修复把
Browser Use 截图从固定 `1500ms` surface preparation timeout 改成了成功返回，
但返回的 `1280 × 720` PNG 内部出现精确平铺：

- 水平方向重复周期为 `800px`；
- 垂直方向重复周期为 `450px`；
- 垂直偏移 `450px` 后采样像素误差为 `0`；
- 工具结果中只有一张图片，因此不是 conversation UI 重复插入。

消息轨迹
`C:\Users\dev\.zcode\cli\debug\model-io-sess_5c7bc8b8-f95f-43eb-b075-cf9f59d5278a.jsonl`
显示模型只显式调用了一次 `tab.screenshot()`。Desktop main 日志同时记录：

1. `21:18:14` 的显式截图；
2. `21:18:24` 在 `turnEnded` 前由 Browser runtime 发起的轮尾截图。

轮尾截图是既有 best-effort 行为，不是单张 PNG 内部平铺的原因。

## 2. 根因

响应式 viewport 的逻辑尺寸是 `1280 × 720`，但 Fit 预览在当前侧栏内只分配了
`800 × 450` 的真实 compositor surface。Windows 显示比例、Desktop 负缩放与
Electron guest surface 组合后，没有像 macOS Retina 那样提供足以覆盖目标 CSS
viewport 的 backing raster。

第一次修复只把负缩放补偿后的 raw layout：

```text
1549 × 871 / layoutScale 1.21 ≈ 1280 × 720
```

还原为逻辑 viewport，并据此发送 ready。这个值只能证明 guest 的 CSS/layout
坐标系正确，不能证明原生 compositor raster 已覆盖同一尺寸。main 收到错误的 ready
后调用 `Page.captureScreenshot`，Chromium 便使用 `800 × 450` surface 周期性填充
`1280 × 720` 输出。

```text
CSS viewport 1280 × 720
  -> responsive Fit visualScale = 0.625
  -> Windows guest compositor surface = 800 × 450
  -> renderer 仅按 logical layout 误报 ready
  -> Page.captureScreenshot target = 1280 × 720
  -> 800 × 450 surface 被周期平铺
```

这说明截图准备协议缺少第二个维度：除 logical viewport 外，还必须携带当前
compositor/preview scale，并据此选择真实可用的截图源。

后续真实 Electron 探针进一步证明：

- `Emulation.setDeviceMetricsOverride(scale: 1 / surfaceScale)` 仍会平铺；
- `dontSetVisibleSize: false` 被 guest widget 拒绝，仍会平铺；
- `captureBeyondViewport: true` 不能修复整帧，连续 tile capture 还可能挂起；
- `deviceScaleFactor`、page scale 和 guest zoom 临时修改均不能补足 raster；
- main 进程直接执行 `guest.capturePage()` 可以得到无平铺的已合成 surface；将该图
  高质量归一化到 logical viewport 后，四角 sentinel 全部正确且无 `800 × 450` 周期。

因此根因不能由 CDP metrics scale 修复。最终方案保留 `surfaceScale` 合同，但在
`surfaceScale < 1` 的普通 viewport screenshot 中读取 main guest surface。

## 3. 目标与非目标

### 3.1 目标

1. Windows Desktop zoom `< 1` 且 responsive Fit `< 100%` 时，截图仍输出与 CSS
   viewport 同尺寸、四角内容正确且无周期平铺的 PNG。
2. 保持用户当前 Fit/固定比例预览、侧栏 tab、焦点、鼠标映射和可访问性状态不变。
3. macOS Retina、Windows 高 DPI、Linux、Desktop zoom `>= 1` 和非 responsive
   viewport 继续复用同一跨平台路径，不写平台特判。
4. prepare、capture、恢复任一步失败时，不返回或持久化已知可能平铺的图片。
5. 显式截图与轮尾截图共享同一修复；轮尾额外截图次数本身不在本次变更范围。

### 3.2 非目标

- 不检测、裁剪或去重已损坏的 tile；尺寸归一化只作用于 `capturePage()` 返回的正确
  已合成 surface。
- 不把 responsive 预览临时切到 `100%`，避免可见跳动、裁切和焦点变化。
- 不创建第二个 Browser runtime、第二个 guest 或手机端专用截图链路。
- 不修改 conversation stream、snapshot、queue、owner/lease 或
  `desktop-continuous` / `web-remote-replayable` 语义。

## 4. 方案选择

采用“ready 上报 preview surface scale + main guest surface capture + CSS 尺寸归一化”。

### 4.1 Renderer ready 合同

截图 surface ready 除现有完整身份和 logical viewport 外，再上报当前 responsive
preview scale：

```ts
interface BrowserViewScreenshotSurfaceReadyPayload {
  // 既有 identity 与 viewport 字段
  surfaceScale: number;
}
```

`surfaceScale` 的语义是当前 guest compositor surface 相对 logical viewport 的
预览比例：

- responsive Fit/固定比例使用 renderer 已实际应用的 visual scale；
- 普通模式为 `1`；
- 必须有限且大于 `0`；
- renderer 连续两个 animation frame 同时确认 guest id、logical viewport 和
  surface scale 稳定后才发送 ready。

不能再把“归一化后的 offset 等于 logical viewport”解释成 raster 已就绪；该值只负责
logical viewport 校验。

### 4.2 Main guest surface capture

`BrowserGuestManager` 在持有 surface lease 期间：

1. 校验 lease 的 guest identity 和 logical viewport；
2. 普通 viewport screenshot 且 `surfaceScale < 1` 时，在 main 进程直接调用
   `guest.capturePage()` 读取已经由 Electron 正确合成的可见 surface；
3. 使用既有宿主 `nativeImage` 高质量 resize 能力，将 surface PNG 归一化到 logical
   viewport 尺寸；
4. `surfaceScale >= 1`、clip 与 fullPage 继续走现有 CDP 截图路径；
5. 无论成功、异常、取消或 late settle，均在底层操作结束后释放 surface lease。

该调用发生在 main 的 guest `webContents` 上，不是 renderer 的
`<webview>.capturePage()`；后者历史上触发过 V8 FATAL，仍然禁止使用。最终路径不改
metrics、DPR、media query、DOM 几何、tab 状态或用户焦点，也没有 Windows 平台分支。

### 4.3 错误与恢复

- 非法或不稳定的 `surfaceScale`：prepare 不 ready，最终走现有结构化 timeout。
- main guest capture 或 CSS 尺寸归一化失败：显式请求返回结构化
  `execution_error`，不回退到已知会平铺的 CDP viewport 图片。
- guest 在 capture 前变化：终止请求，不对新 guest 使用旧 lease。
- 自动轮尾截图继续 best-effort 跳过失败图片，不影响 task 正常结束。

高频 prepare/ready/capture/release 细节只记 `debug`，不得记录图片 base64 或页面正文。

## 5. 时序

```text
Browser screenshot request
  -> main read logical viewport
  -> renderer compose target guest
       -> stable guest id
       -> stable logical viewport 1280 × 720
       -> stable surfaceScale 0.625
       -> ready
  -> main acquire surface lease
  -> verify guest identity
  -> main guest.capturePage() 读取正确的 800 × 450 已合成 surface
  -> nativeImage 高质量归一化到 1280 × 720 CSS 尺寸
  -> release surface lease
  -> return PNG
```

该链路不改变 guest 或用户看到的 responsive frame 几何。

## 6. 未采用方案

### 临时把 responsive DOM frame 切到 100%

能够扩大 surface，但同一个 guest 也是当前可见预览；切换会造成闪烁、裁切或侧栏
scroll extent 变化，并增加 active/inactive tab 两套行为。

### `fromSurface=false` 或只改 `captureBeyondViewport`

既有 Electron 隔离验证已证明后台/被遮挡 guest 可能返回黑图或错误尺寸，且不能修复
旧 surface 平铺。

### 识别并裁剪/去重损坏图片

无法证明第一块 tile 覆盖完整 viewport，会破坏截图坐标与后续点击坐标的对应关系。

### capture-only CDP metrics scale

Windows Electron 探针已证明 `scale`、DPR、page scale、guest zoom 和 visible size 路径
均不能让小 surface 覆盖 logical viewport，其中 visible size 请求还会被 guest widget
拒绝。不能继续依赖只在 mock 中成立的 CDP 参数组合。

## 7. 测试与验收

严格按 TDD 实施：

1. Shared/UI：ready payload 校验并上报稳定 `surfaceScale`；负缩放 raw layout 仍只用于
   logical viewport，不再代表 raster ready。
2. Coordinator：完整 identity、viewport、surfaceScale 校验；非法、变化和迟到 ready
   不得建立 lease。
3. Manager：`surfaceScale < 1` 的普通 viewport screenshot 必须调用 main
   `guest.capturePage()` 并归一化到 logical viewport；成功、异常、取消和 guest
   变化均在底层操作 settle 后 release。
4. Executor：仅普通 viewport screenshot 使用已注入的 guest surface；clip、fullPage
   与质量重抓继续保持既有 CDP/CSS 像素合同。
5. Electron compositor smoke：
   - logical viewport `1280 × 720`；
   - 历史/可见 surface `800 × 450`；
   - Windows scale factor `1.25` 与 Desktop zoom `-2`；
   - 修复前测试必须识别 `800 × 450` 周期平铺；
   - 修复后 PNG 为 `1280 × 720`，四角 sentinel 不同，水平/垂直周期匹配率低于阈值。
6. 产品回归：重启 dev desktop，在 zoom `-2` 下让真实模型打开 `example.com` 并显式截图；
   必须实际查看图片，不能只以 `ok=true` 和 IHDR 尺寸作为通过。
7. 执行 `pnpm typecheck` 与 `pnpm lint`。

## 8. 多端与架构边界

- 变更只发生在 Desktop owner renderer 与 main 的瞬时截图协调中。
- Web/手机端不创建独立 embedded browser runtime，仍通过 shared-host attachment
  读取桌面成功持久化的图片事实。
- `workspaceKey = workspaceIdentity?.trim() || workspacePath`、`remoteSessionId` 和完整
  browser/session/tab identity 继续贯穿 prepare/ready/release。
- 不新增 relay 业务状态，不把 screenshot surface 状态写入 replayable snapshot。
- 若当前机器无法覆盖 macOS/Linux，提交说明必须明确 Windows 已验证、其他平台待 CI
  回归的风险。
