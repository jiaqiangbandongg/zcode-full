# Provider 横幅裁切：Pro 运行时调查

> 2026-09-10。状态：未复现原图，根因未确认；不得标为已修复。本轮只诊断，未修改产品代码。

> 后续用户裁决：先忽略本项。保持调查记录，不继续实施或作为本轮其他 Todo 的完成前置；本轮待办汇总见 [Todo107](./todo-107-provider-settings-feedback-enablement-and-template-links.md)。

## 原始现象

Air 的连接测试成功横幅下半部缺失，模型行仍可见；下方同时有另一型号的测试中横幅。原始附件：剪贴板截图 `d51e6f7f-bf4e-4753-bdbd-87056848d5b3.png`。

## 实际调查

- Pro 没有运行中的 ZCode，从已有开发构建启动 Electron 并连接 CDP。发现其构建较旧，不能作为 Air 同版本验证。
- 从 Air 当前安装包只提取 renderer 资源，在 Pro 临时目录加载这份实际前端。未替换源码或原构建。Host 仍为 Pro 原构建，存在账号／配置 DTO 不一致，因此仅用于前端布局诊断，不代表完整应用同版本验收。
- 两台 Electron 均为 41.0.3、macOS 均为 26.6.2；Air 为 M4，Pro 为 M5。Pro GPU 合成和 Metal 均开启。
- 通过原有 `ProviderDetailFeedbackBoundary` 的 Context 注入临时 success / pending，不调用模型接口，不保存 Provider 配置；另设置模型行的临时 isTesting 状态以复现原图转圈动画。临时调整列表位置使模型行位于横幅下方。
- 检查两条／三条提示、移除中间提示、窗口尺寸改变、滚动及模型行 transform。记录祖先 overflow、z-index、边界和合成层。
- 两条提示实测高度各 44 CSS px，间距 8 px，整体 96 px；位于详情面板边界内，横幅 viewport 的 z-index 为 20。合成层理由包含 BackdropFilter，但这不是它导致故障的证据。
- 连续 12 轮提示／滚动变化收到 68 个 screencast 帧，保存 12 个采样帧并人工抽查 0/3/6/9/11；未见原图下半截消失。各轮 DOM 横幅底部命中检查均未发现被模型行遮挡。
- 系统 screencapture 在用户唤醒 Pro 后仍返回 `could not create image from display`；未修改屏幕录制权限或安全设置。CDP 截图／录帧可用，不能用它们替代未取得的系统屏幕证据。

## 结论与下一步

本次复现条件下，未发现普通 CSS 层级或父容器 overflow 将横幅拦腰裁切。此结论不否认用户截图，也不能完全排除其他时序／设备条件下的布局问题。

“backdrop-filter 与 GPU 合成发生绘制异常”仍只是候选，尚无故障前后对照证明；禁止据此宣称根因或直接增加 z-index / 删除 blur 作为已验证修复。

下一步应在 Air 真正复现时连接 CDP，同一时刻记录横幅 rect、合成层和屏幕图，再做仅影响内存样式的单变量对照（例如去掉 blur、禁用相关动画）。Air 当前无调试端口，重启前需与用户确认，不能擅自打断任务。

## 临时证据

- 本机 `/tmp/pro-banner-stress-evidence.json`：每轮几何及命中结果。
- 本机 `/tmp/pro-banner-frame-0.png` 至 `11.png`：采样帧。
- 本机 `/tmp/pro-banner-row-spinner.png`：模型行与横幅同时转圈场景。
- 本机 `/tmp/zcode-banner-stress.cjs`、`/tmp/zcode-pro-banner-cdp.cjs`：诊断脚本，不是正式测试或生产代码。

以上为临时诊断文件，不是永久回归证据；实施修复时仍须留下可重复的正式用例。
