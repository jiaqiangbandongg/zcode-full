# Todo150：Coding Plan 模板名称去掉 API

状态：已实现并完成定向验证、代码复审；未推送、未发布线上配置，待实机展示验收。

## 范围与约束

- 添加供应商上排名称改为 `BigModel Coding Plan`、`Z.ai Coding Plan`，中英文一致。
- 下排普通 API 为 `BigModel API`、`Z.ai API`。
- 只修改 Built-in 的 `templateNameMap`，复用页面现有读取逻辑，不加前端特判。
- 保留模板 ID、Access、URL、模型配置与已有 Personal Provider 名称，不做数据迁移。
- 生产配置 revision 升至 28，通过现有脚本生成测试配置；不自动发布远端配置。
- 本条延续并取代 [Todo111](./todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md) 的历史模板命名。

## 实施与验收（2026-09-14）

2026-09-15 补充：按用户指定品牌写法，将两个模板的 `Z.AI` 改为 `Z.ai`。仅改模板中英文名称，并生成测试配置；不扩大为账号 Provider、历史文档或用户个人名称的全局替换。新增生产／测试配置断言，并在现有双主题浏览器图标用例中核对卡片及 tooltip 名称。

补充验证：名称单测先红 2 项；修改后 Zhipu／OpenRouter 两文件 18 项通过，Pro 双主题 Z.ai 图标与模板名称、OpenRouter 名称共 4 个浏览器用例通过。tooltip 检查后显式按 Escape 关闭并等待消失，避免前一提示影响下一卡片。typecheck、Desktop typecheck:e2e、配置同步检查、架构检查通过，lint 0 错误、42 条既有警告。浏览器 pending 不替代完整安装包／手机远控验收，未发布线上配置。

- [x] 实现提交：`b43bcb2588`。
- [x] 先补名称断言并确认失败，修改后模板与配置完整性测试共 15 项通过。
- [x] 生产／测试配置同步检查、typecheck、格式检查通过；lint 0 错误、42 条既有警告；架构检查 0 违规。
- [x] 复审确认配置仅修改名称及 revision，普通 API 与其他行为不变。
- [ ] 配置发布后，实机确认添加供应商页面两张卡片名称正确；本轮未执行桌面／手机界面验收。
