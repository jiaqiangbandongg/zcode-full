# 07 — 收口：删除 V1 契约与旧 Docker 构建链，文档与验收对齐

**What to build:** 两端都只剩 V2 之后，做 contract 阶段：删除 shared 中的 V1 relay 契约与二维码 `hash`/`t` 支持，删除 `/remote`、`/remote/v3`、`/remote/v4` 三条旧 Docker 构建链及对已迁走基础设施的引用，把架构文档、静态部署文档收口到最终行为，标注被取代的旧设计，并在测试环境完成完整真机验收矩阵。完成后仓库内没有任何 V1 代码路径，也没有能把 V2 页面误发到旧单一部署的脚本。

**Blocked by:** 03、04、05、06

**Status:** in-progress

**Parent:** [Web 远控接入 Relay V2：手机登录后连接桌面](./01-relay-v2-login-pairing.md)

## 验收标准

- [x] shared 删除 V1 relay 消息类型、V1 解析分支、proof 测试向量、二维码 `hash`/`t` 的构建与解析支持、V1 心跳常量；两端与测试无任何引用。
- [ ] 删除 `/remote`、`/remote/v3`、`/remote/v4` 的 Dockerfile、nginx 配置、构建/推送/验证脚本与 package.json 命令；仅被这些 Docker 链使用的辅助脚本一并删除，被 OSS 流水线或 `/remote/__test__` 复用的保留。`/remote/__test__` 链与 OSS 流水线继续可用。
- [x] 删除脚本与文档中对 旧基础设施仓库、其路径环境变量和旧 Deployment 文件 的引用。
- [x] 文档收口：架构文档删除 V1 与 Docker 部署段落、"静态部署"节改为只描述 OSS 多版本链路并标注旧 Docker 部署冻结在最后一次 V1 镜像；`remote-v4-static-deployment.md` 同步删除 Docker/Jenkins 段落；`docs/superpowers/specs/2026-04-28-web-remote-login-design.md` 顶部标注被本 spec 取代；`relay-v2-pairing.md` 补已知限制（旧链接连新桌面停在等待页、离线设备无 `meta`、`KICKED` 语义折中）与外部依赖表。
- [ ] 测试环境完整真机验收矩阵执行并记录到 `relay-v2-pairing.md`：扫码首次登录、已登录直连、无码选设备、账号不匹配与切换账号、另一台手机接管（本机停止重连并提示）、桌面登出后手机断开与登录后恢复、relay 滚动导致的 `KICKED` 自动恢复。
- [ ] 全部文档链接、命令与引用一致性检查通过；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测、`pnpm verify:pre-push` 通过。

## 实施记录（2026-09-19）

- V1 relay 类型、proof 向量、QR overload 和心跳常量已删除。QR 默认解析 V2、拒绝旧凭据参数；共享 payload 序列化器默认时间戳收口为 Unix 秒。
- 三条旧单目录 Docker 构建/推送/验证入口及 npm 命令已移除。OSS 工具保留；独立测试发布脚本只构建推送镜像，旧基础设施仓库更新/MR 逻辑删除。
- 测试 Dockerfile 实际构建发现缺 patches；已补齐补丁、provider、public 与 Git 安装工具，回归通过。再次构建在私有 CUA Git 依赖认证失败，尚未完成 Docker smoke，不能勾选完整可用性。
- 架构、静态部署、登录文档已对齐最终行为；历史部署步骤归档并链接现行入口。真机矩阵与外部依赖见 [Relay V2](../../web-remote-control/relay-v2-pairing.md#测试环境真机验收矩阵07)，全部真机场景仍待执行。
- 完整验证结果见同文档的 07 验证记录。必要验证未全部完成，保持 `in-progress`；按仓库规则保留工作区改动，不自动提交。
