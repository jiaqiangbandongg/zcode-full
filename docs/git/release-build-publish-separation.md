# Release 构建与发布元数据分离

## 目的

安装包、签名、公证、blockmap 和 Electron Builder 生成的 `latest.yml` 在构建阶段完成。发布日志由 infra 通过 API 直接编辑共享目录中的更新清单；z-code CI 的人工确认只决定是否继续上传/发布，不再读取仓库 changelog 或改写更新清单。

## 当前 CI 时序

```text
pnpm release（默认 release-it）
   version + CHANGELOG.md + release commit/tag/push
   |
   v
commit/tag
   |
   +--> build:macos/windows/linux
   |      installer + blockmap + 基础 latest.yml
   |      共享目录中的候选制品保持未注入 releaseNotes
   |
   v
   release:approve  <--- infra 完成日志编辑后人工放行
          |
          v
   release:validate
      校验六个平台 update YAML、日志、安装包摘要和 remote components
          |
          v
   release:upload:* (RELEASE_ARTIFACT_MODE=publish)
          |
          v
   CDN preload -> gray publish -> stable publish
```

`release:approve` 之前不会调用正式 OSS 上传或 release API。安装包保存在 CI runner 共享目录，approve 放行后先执行 validate，校验通过后才由 upload job 读取。

## release-it 边界

`pnpm release` 只运行 `.release-it.mjs` 中的默认发布能力和 `@release-it/conventional-changelog`：更新版本、维护根目录 `CHANGELOG.md`、创建 release commit/tag 并 push。仓库不再为 release-it 挂载 AI 改写、飞书评审或 `changelogs/vX.Y.Z*.md` 本地生成插件；CI 发布链路也不再消费根目录 `CHANGELOG.md`。

日志编辑由 infra 负责并直接落到 runner 共享目录中的 `latest.yml`。全部构建完成且 infra 完成日志编辑后，发布负责人通过 `release:approve` 人工门禁放行；随后 `release:validate` 自动统一检查六个平台的版本、非空日志、update YAML 引用、文件大小和摘要，并要求 remote manifest 精确包含 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64` 四个平台且内部 `platformArch` 与文件名一致。只有完整性检查通过，各平台 upload job 才会读取共享目录中的最新内容上传。

`build:remote:assets` 每次收集当前版本前只清理共享发布根目录中的旧 `manifest-*.json` 和 `components/`，不触碰并行平台构建写入的 `macos-*`、`windows-*`、`linux-*` 目录。这样同版本重试不会把上一次的 remote manifest 或组件混入当前候选集合。

## 关键文件

- `scripts/ci-collect-artifacts.mjs`：只收集并修正基础制品，不再注入 release notes。
- `scripts/validate-release-artifacts.mjs`：approve 放行后、upload 前校验六个平台和 remote assets 的完整性。
- `scripts/upload-oss.sh`：正式上传使用 `RELEASE_ARTIFACT_MODE=publish`，从共享目录读取 infra 编辑后的清单；缺少顶层 `releaseNotes: |-` 时 fail-closed。
- `.gitlab/ci/50-release.yml`：`release:approve` 确认 infra 日志已准备完成，随后 `release:validate` 提供统一完整性 gate，各平台 upload job 依赖 validate。

## 失败与重试

- infra 尚未向共享目录中的 `latest.yml` 写入日志：不得点击 approve；若提前放行，validate 阶段拒绝发布。
- 版本、引用文件、size、sha512、remote manifest 四平台集合或 remote component 任一不一致：validate 阶段拒绝发布。
- 单个平台上传失败：不需要重新构建；从同一共享候选目录重试对应 upload job。
