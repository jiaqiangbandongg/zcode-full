# 产品能力图：工程基础设施扩展

## Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 把 CI/CD、发版、E2E 自动化和质量数据工作从三层产品运行时之外单独列出 |
| Capability | Engineering Infrastructure |
| Change layer | presentation |
| Operating mode | planning |
| Primary seeds | `.gitlab/ci/*.yml`、`packages/desktop/scripts`、`packages/desktop/test/e2e`、`packages/distillation`、`packages/e2e-report`、`scripts/ci` |
| Out of scope | 修改真实 CI、发布、E2E 或产品运行时行为 |

## UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Default/inherit source | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 浏览能力归属和维护复杂度 | Developer Docs 能力地图 | React Flow、ELK、能力图权威数据 | 页面本地筛选和选择状态 | `productCapabilityMap.ts` | 数据引用与布局回归测试 | 只读选择节点/群 | 仓库内静态审计数据 | Desktop/Web/Mobile 同一只读图 | 产品运行时、CI 和发布系统的真实状态 |

## Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters for this change |
| --- | --- | --- | --- |
| UI/component | 四个顶层区域复用同一套群、节点和边组件 | 前三层横向排列；工程基础设施位于下方 | 空间位置直接表达“不是第 4 个产品进程层” |
| Option source | 同一份能力关系数据 | 基础设施节点使用工程源码和流水线事实 | 避免把测试/发布工作误写成线上功能 |
| Commit effect | 无 | 无 | 本次只修改文档可视化 |
| Persistence/recovery | 无运行态持久化 | 能力图数据随 Git 版本维护 | 不接入任务、会话、遥测或 CI 后端 |

## Feature Relationships

| Rank | From | Semantic edge | To | Condition | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| must-inspect | 构建与发布工程 | produces update artifacts for | Host 客户端更新生命周期 | 仅通过安装包和 update feed 交付 | 现有 Host “更新与发布”混合了研发发布与客户端 updater | `.gitlab/ci/30-build.yml`、`.gitlab/ci/50-release.yml`、`packages/desktop/src/main/autoUpdater.ts` |
| must-inspect | 测试自动化平台 | publishes results to | 质量数据与工程治理 | E2E 结束后生成 summary、coverage、video | 报告和执行平台是两个维护边界 | `packages/desktop/test/e2e/reporting`、`packages/e2e-report` |
| should-inspect | CI 流水线 | schedules | 构建、测试和静态门禁 | GitLab pipeline | 确认 CI 是编排者而不是所有能力的 owner | `.gitlab/ci/20-test.yml`、`.gitlab/ci/30-build.yml` |
| invariant-only | 工程质量数据 | must remain isolated from | 产品可观测性 | 所有环境 | 测试通过率、覆盖率和时长不是用户行为数据 | `docs/testing/desktop-e2e-reporting.md`、`docs/monitoring/performance-telemetry-catalog.md` |
| evidence-only | E2E case | verifies | 对应产品能力 | 仅作为验证证据 | 测试可达性不构成产品运行时依赖 | `docs/feature-impact-discovery.md` |

## State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| --- | --- | --- | --- | --- | --- |
| Pipeline DAG | GitLab UI | `.gitlab/ci/*.yml` | GitLab Runner | CI pipeline/job/artifact | `.gitlab-ci.yml` |
| Release artifacts | CI job | 构建与发布 pipeline | build/sign/upload/publish scripts | GitLab artifact、OSS/CDN、update feed | `.gitlab/ci/30-build.yml`、`.gitlab/ci/50-release.yml` |
| E2E execution | WDIO/CLI runner | test harness + fixture contract | WDIO、Docker、capture/replay runner | `.e2e-artifacts`、fixture/capture | `packages/desktop/wdio.conf.ts`、`packages/distillation` |
| Quality summary | report generator/viewer | E2E summary and coverage artifacts | reporter/upload scripts | summary JSON/Markdown、video、Bitable/report platform | `packages/e2e-report`、`scripts/ci/push-e2e-*.mjs` |

## Must-Preserve Invariants

| Invariant | Surfaces/modes | Proof needed | Evidence |
| --- | --- | --- | --- |
| 工程基础设施不成为产品运行时依赖 | Renderer/Host/CLI | 图中只画构建、验证、度量、交付关系 | 能力图边审计 |
| 客户端 updater 与研发发布 pipeline 分属不同节点 | Desktop + CI | Host 节点仅保留检查/下载/安装；基础设施拥有打包/签名/发布 | 节点文案和边 |
| 产品功能 E2E case 不重复计入测试平台 LOC | 所有测试域 | 只统计共享 harness/runner/reporter | 代码量审计口径 |
| 工程质量数据不进入产品 telemetry/App Usage | CI + runtime | 使用隔离关系边明确表达 | 质量数据节点与可观测性节点 |

## Codegraph Evidence

当前能力图 worktree 未建立 codegraph 索引，因此没有重复调用冻结索引；本次按技能约束使用精确文件和文本种子核对未索引配置、脚本与文档。

| Seed | Query | Direct callers / key path | Depth | Interpretation |
| --- | --- | --- | --- | --- |
| `.gitlab/ci/00-workflow.yml` | `rg` stage/rule | test -> build -> notify -> approve -> validate -> upload -> preload -> publish -> promote | 2 | 发布是异步 CI DAG，不是 Host 进程能力 |
| `packages/desktop/wdio.conf.ts` | `rg` E2E helper/reporter | Electron service、fixture、capture/replay、summary | 2 | Desktop E2E 有独立共享平台 |
| `packages/e2e-report` | file inventory | node reporter -> viewer -> CI upload | 2 | 质量数据有独立生成、展示和上传链 |

## Graph Drift Candidates

| Candidate | Live-code evidence | Missing/stale graph relation | Proposed follow-up |
| --- | --- | --- | --- |
| Engineering Infrastructure | `.gitlab/ci`、E2E harness、report package 均为稳定边界 | 功能语义图此前只有产品运行时能力 | 增加构建发布、测试自动化、质量治理能力及隔离关系 |
| Client Update Lifecycle | `autoUpdater.ts` 与 CI release scripts 权威源不同 | 原能力图 “Update & Release” 混合两个 owner | 收窄 Host 节点并由发布制品边连接 |

## Graph Delta

| Status | Node/edge | Semantic reason | Evidence | Action |
| --- | --- | --- | --- | --- |
| confirmed | `capability.engineering-infrastructure` | 用户确认三大运行块之外需要独立基建区域 | 用户决策 + 仓库事实 | 更新功能语义图 |
| confirmed | build/release、test automation、quality intelligence | 三类工作有不同权威源和交付物 | CI、WDIO/distillation、E2E report | 更新功能语义图 |
| confirmed | quality intelligence must remain separate from data observability | 工程质量与产品行为数据用途、对象和通道不同 | 当前监控与 E2E 文档 | 增加隔离边 |

## Unresolved Questions

无。本次不重分配具体产品 E2E case 的 owner，也不修改真实流水线行为。

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| 顶层布局 | 工程基础设施作为底部独立区域 | 三个基建能力群 | 第四个产品运行进程层 | 用户 |
| 更新边界 | CI release 与 Host updater 分离 | 制品生产/发布；客户端消费/安装 | 一个节点同时拥有两类状态 | 用户 + code |
| LOC | 统计主责工程源码 | CI 配置、脚本、共享 harness/reporter | 产品功能 case、fixtures、docs | 当前能力图口径 |
| 关系 | 只画语义关系 | 调度、验证、质量数据、制品交付、隔离 | 普通 test import 和静态可达 | 功能影响规范 |

## Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| INFRA-MAP-01 | 加载完整能力图 | 适应全局视图 | 前三层横向，工程基础设施位于下方 | DOM + layout | automated |
| INFRA-MAP-02 | 选择基础设施群 | 查看详情 | 显示工程 LOC、跨群入度/出度和节点 | DOM | automated |
| INFRA-MAP-03 | 桌面和手机宽度、亮/暗主题 | 浏览与缩放 | 无横向页面溢出，节点和详情可读 | screenshot | manual |

## Planning Handoff

| Item | Destination | Status |
| --- | --- | --- |
| Spec update | `docs/product-capability-map.md` | complete |
| Case catalog | 本文 Accepted Cases | complete |
| Coverage matrix | 本文 Accepted Cases | complete |
| Decision backlog | 无 | complete |
| E2E handoff | dev-docs layout/data unit tests + browser smoke | ready |
