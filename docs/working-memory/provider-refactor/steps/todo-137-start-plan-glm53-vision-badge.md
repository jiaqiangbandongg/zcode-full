# Todo137：体验套餐 GLM-5.3 隐藏视觉标

> 状态：已实现，验收结果见下文。2026-09-12。

## 背景与裁决

[Todo126 第4节](todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md) 只覆盖个人、团队 Coding Plan 和手动套餐 Key。当前共用判断遗漏体验套餐 `start-plan`，旧单测还明确要求它显示视觉标。用户确认体验套餐也应隐藏 GLM-5.3 视觉标，沿用既有展示特例。

## 修改后的规则

- `supportsImage !== true` 时不显示。
- 当模型 ID 忽略大小写后精确等于 `glm-5.3`，且 Access 是手动 Coding Plan Key，或账号个人／团队／体验套餐时隐藏。
- Z.ai、BigModel 体验套餐都适用。Flash、其他型号、普通 API Key 与闲时套餐沿用现状。
- 只改 `shouldShowModelVisionBadge` 的展示条件。设置页和模型选择菜单共用判断，桌面和手机 Web 一致；图片上传、实际图片能力、模型请求、配置文件、Schema 和 builtin revision 均不变。

## 实施与验收

- [x] 先扩充设置页与菜单单测，覆盖两家 Start、保留 Flash 和真实 supportsImage；确认旧实现失败。
- [x] 共用判断增加 `start-plan`，注释说明遗漏原因，不增加状态、接口或额外判断链。
- [x] 扩充现有浏览器用例，分别访问两家 Start，验证设置列表与打开的模型菜单；覆盖390中文浅色、1200英文深色，保留已有套餐回归。用例仍为 pending，不冒充原生端或手机 Host 联调。
- [x] 跑相关单测、浏览器用例、typecheck、lint 与架构检查，记录结果后提交。

## 实施记录（2026-09-12）

- 生产仅修改 UI 共用纯函数：增加 `start-plan`，变量改名避免把体验套餐称为 Coding Plan；设置行和模型菜单现有调用链不变。
- 先红：两个单测文件共3项失败（两家 Start 菜单、设置行），两项浏览器用例均因 Start 的 GLM-5.3 仍有视觉标失败。修复后77项单测、2项浏览器用例通过；每项浏览器用例遍历两家 Start、个人、团队与手动套餐 Key。
- 浏览器覆盖390中文浅色与1200英文深色，实际打开模型菜单并检查设置行；GLM-5.3 隐藏、Flash 保留，截图在 `/tmp/zcode-provider-settings-batch/vision-start-*.png`。使用已有隔离 Chromium 运行库解决本机 libatk 缺失，没有修改系统或产品依赖。此为共享组件浏览器验收，不代替 Windows/macOS 原生包或真实手机远控。
- 根 `pnpm typecheck` 通过；`pnpm lint` 为0错误、42条未修改文件警告；架构检查0违规。首次单独 E2E 类型检查遇到旧依赖声明，根类型构建完成后重跑 `pnpm --filter @zcode/desktop typecheck:e2e` 通过。
- 没有修改 Provider/Model 配置、Schema、网络、图片能力或上传链路，没有 builtin revision 变动。
