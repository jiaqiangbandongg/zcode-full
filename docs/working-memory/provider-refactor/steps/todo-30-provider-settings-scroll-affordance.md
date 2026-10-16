# Todo 30：Provider 设置页滚动边界提示

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：Provider 设置页真实体验反馈

## 1. 问题

Provider 设置页已经让左侧 Provider 导航和右侧详情各自独立滚动，但 macOS 默认可能隐藏系统滚动条。固定高度容器刚好在完整行边界截断时，用户容易误以为下方没有更多内容。

本 Todo 不改变滚动区域、容器高度、Provider/Model 排序或配置保存，只增加条件式滚动边界提示。

## 2. 交互

```text
无溢出
└─ 不显示提示

位于顶部且下方有内容
└─ 只显示底部渐隐

位于中间
├─ 显示顶部渐隐
└─ 显示底部渐隐

位于底部
└─ 只显示顶部渐隐
```

- 左右两栏分别测量、分别更新，不共享滚动状态；
- 保留系统滚动条行为，不强制常驻，不增加文字或箭头；
- 渐隐层不接收指针事件，不遮挡模型操作、拖拽或 Provider 选择；
- 使用语义化 Card 颜色，在 Zai Light / Zai Dark 下保持一致；
- 内容变化、容器缩放和窗口缩放后重新测量；
- 滚动监听使用 passive listener，并避免相同边界状态导致重复 React render。

## 3. 验证

- 纯函数覆盖无溢出、顶部、中间、底部及 1px 误差；
- 组件测试覆盖滚动后 `top/bottom` 提示状态；
- 布局测试证明 Provider 导航和详情都使用同一组件；
- 回归 Provider/Model 拖拽、左右独立滚动、详情反馈横幅和窄屏布局；
- 执行 UI 定向测试、typecheck、lint、格式检查和 `git diff --check`。

## 4. 实施结果

- 新增 `ScrollEdgeShadowViewport`，左右两栏复用同一套边界测量和语义色渐隐；
- 监听当前 viewport 的 passive scroll，并用 `ResizeObserver` 观察 viewport/content 尺寸变化；
- 相同 `top/bottom` 状态保持原对象，避免滚动期间产生无意义 React render；
- 渐隐层使用 `pointer-events-none`，详情反馈横幅继续位于更高层级；
- 322 个 Provider 设置相关测试、全仓 typecheck 与 lint 通过；lint 仅保留本轮前已有 warning。
