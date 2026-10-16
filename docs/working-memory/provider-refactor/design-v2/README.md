# Provider Refactor Design V2

> 状态：现行设计入口
> 基线：以本目录建立时的 Provider Refactor 分支实现和已裁决决策为准
> 范围：Provider / Model 配置、解析、Registry、Model 创建、账号 Overlay、设置投影与执行边界

## 为什么建立 V2

Provider Refactor 经历了多轮设计、实现、实机反馈和边界修正。旧 `design/`、`steps/`、`research/`、
`plan/` 与实施日志保留了完整过程，但其中同时存在：

- 已经落地的现行设计；
- 被后续 Todo 明确取代的阶段性设计；
- 只用于发现问题、从未成为设计的研究候选；
- 已完成实现的历史记录；
- 暂缓、草案或仍在执行的工作；
- 与当前代码事实不一致的旧术语和旧 Schema。

本目录不再延续那种按迁移阶段累积上下文的写法，而是重新整理为两条线：

1. [`design.md`](./design.md)：只写当前应被遵守的核心设计、原则和边界；
2. [`evidence-and-contradictions.md`](./evidence-and-contradictions.md)：记录证据来源、历史矛盾、裁定结果、
   staging 差异和未完成事项，供考证与审计。

## 权威顺序

发生冲突时按以下顺序判断：

1. 最新的明确用户裁决和已经接受的后续设计；
2. 当前领域 Schema、Resolver、Registry、ModelFactory 及其测试所证明的实现事实；
3. 本目录的现行设计；
4. 旧 `design/` 中尚未被后续决策或代码取代的内容；
5. 已完成 Todo / Bugfix 的最终结论；
6. Research、Draft、Delayed Todo、实施日志和历史计划。

第二项只能证明“现在实现了什么”，不能推翻第一项。当实现与已裁决设计不一致时，应记录为实现漂移并修正实现，
不能把偶然代码行为升级为设计。

## 阅读方式

- 要理解 Provider Refactor 最终要解决什么、系统为何这样分层：读 [`design.md`](./design.md)。
- 要判断某个旧字段、旧名词或旧 Todo 是否仍有效：查
  [`evidence-and-contradictions.md`](./evidence-and-contradictions.md)。
- 要复盘具体迁移过程、测试证据或历史事故：再回到上一级的 `steps/`、`research/` 和 `plan/`。

## 维护规则

- 新的 Provider 核心设计决策先更新 `design.md`，再实现代码。
- 旧材料与现行设计发生新冲突时，不篡改历史材料；在考证文档新增裁定记录。
- 只有完成裁决并进入现行目标的内容才能写入 `design.md`。
- Draft、Delayed、Research 或正在执行但尚未验证的实现，必须留在考证文档的未完成区。
- 本目录不引入新的领域对象；“V2”只是文档整理版本，不是运行时版本、Config Schema 版本或迁移协议。
