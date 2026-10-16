# Feature Boundary Graph 可视化

## 目标

在 `@zcode/dev-docs` 中提供 `feature-boundary-planner` 语义图的可读视图，替代在对话区域查看大图。页面直接读取
`.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`，让开发者可以从能力节点追踪 UI 入口、状态 owner、服务、持久化和交付边界。

## 产品边界

- 图谱以 YAML 为唯一数据源；页面构建时解析 YAML，不维护第二份手写节点关系数据。
- 默认展示完整语义图，支持按关键词定位节点、按关系等级收窄连线，并保留画布缩放、平移和适配视图。
- 选中节点后只突出一阶邻居，并在详情栏展示节点类型、ID、别名、文档、代码种子、不变量和直接关系。
- YAML 中引用但未在 `nodes` 声明的端点以“未声明端点”显示，不自动补写产品语义。
- 页面只读，不修改 YAML，也不把静态可达性解释成新的产品依赖。

## 实现约束

- 使用已有 `@xyflow/react` 和 dev-docs 的主题 token，兼容浅色/深色主题与窄屏布局。
- 图谱加载失败时显示明确错误状态；布局在后台计算，首屏显示加载状态。
- 节点和详情交互必须支持键盘操作；选中状态通过 `aria-live` 暴露。
- 关系与节点类型使用稳定的颜色/文字组合，不能只依赖颜色传达含义。

## 验证证据

- 单元测试校验 YAML 解析后的节点/边计数、未声明端点保留和直接邻居计算。
- `@zcode/dev-docs` 的 typecheck、lint、unit test 和 production build 必须通过。
