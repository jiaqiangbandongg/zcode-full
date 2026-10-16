# Todo148：Z.AI 供应商复用系统 ZCode 图标

状态：2026-09-15 按 Dock 截图纠正素材，开发与本轮验证完成。

## 规范与边界

- 用户指定的是 Dock 黑底白 Z 应用图标，不是旧 `logo-zai.svg` 的灰色描边版本。
- 原样复制现有 `packages/desktop/build/icons/128x128.png` 到 UI 静态资源
  `model-provider-zai-app.png`；该尺寸版本无 Dock 大图的额外外围留白，不重画、不裁切、不反色。
  UI 不跨层引用 Desktop 路径；单测验证打包副本与应用源文件字节相同。
- 通过 `ProviderLogo` 的 `zai` 资源映射统一覆盖供应商列表、详情标题、添加模板等现有调用点；
  不新增按 Provider ID 判断，不修改 Built-in JSON、Schema、个人配置或模型行为。
- BigModel 蓝色图标及其他品牌不变；深浅主题、桌面及 Web 共用同一静态打包资源，保留尺寸与加载失败回退。
- 来源清单指向实际使用的 PNG 及应用源路径；旧 SVG 和其他入口保持不变，不扩大素材清理。

## 验收

- [x] 单测确认 Z.AI 深浅主题都引用同一应用 PNG，副本字节相同；BigModel 仍引用原素材。
- [x] 保留图片无障碍属性、既有尺寸和加载失败回退；图标资源检查通过。
- [x] 浏览器验证模板、导航和详情实际加载 PNG，390 中文浅色／1200 英文深色截图复审；类型、lint、架构检查。

本次只替换静态素材引用，无交互行为变化；补现有 Provider 浏览器 pending 用例，不宣称完整远控链路验收。

## 验证与复审（2026-09-15）

- 单测先红（4 项失败），替换后 `providerLogo`／`providerLogoAssets` 两文件 9 项通过。
- Pro 隔离副本运行浏览器 `zai app icon` 两例通过，模板、导航、详情图片实际解码为 128×128，无反色、页面异常或额外保存。
- 复审四张模板／详情截图：390 中文浅色与 1200 英文深色均使用指定的黑底白 Z。
- 根目录 `pnpm typecheck`、Desktop `typecheck:e2e` 通过；`pnpm lint` 0 错误、42 条既有警告；architecture 0 违规。
- 产品代码只替换 `ProviderLogo` 的静态素材引用；旧 SVG、BigModel、配置格式、Provider ID、交互和实时链路均未改。
- 浏览器用例仍为 pending；未执行完整 Electron／手机 shared-host E2E。codegraph 不可用，未执行影响面扫描。

## 验证与复审（2026-09-14）

以下是此前误选 SVG 的历史记录，不代表本轮 PNG 已验收。

- 先补测试，旧 PNG 引用下新增 3 项断言失败；替换后 2 文件 8 项全部通过。
- 根目录 typecheck 通过，lint 0 错误、42 条既有警告，architecture 0 违规。
- 实际渲染系统 SVG 并查看放大图，原有直切端点、圆角底板、渐变和细描边均保留。
- 复审确认系统 SVG 与 Built-in 配置均未修改，只有资源引用、来源清单、测试及本 Todo 有变更。
- 未执行桌面／手机整页实机 E2E；本次使用共享组件单测和素材渲染检查，不声称已完成整页验收。
