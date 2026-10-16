# Desktop CI Artifact Layout

## 背景

桌面端 CI 会把 Electron 安装包先写入共享目录，再由后续 upload / publish job 读取。旧结构中 macOS 产物写在 release 根目录，Windows 和 Linux 同时写根目录与架构子目录，导致根目录混合多个平台的安装包、更新清单、远程 runtime manifest 和 components。并行构建时也更容易出现 `latest*.yml` 覆盖或人工验收拿错目录的问题。

## 目标结构

`TARGET_OUTPUT_DIR` 仍由 workflow 统一决定，例如 MR 到 `staging` 使用 `@electron/dev/$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME/`。桌面安装包、blockmap、更新清单和平台本地 `manifest.json` 只写入平台架构目录；release 根目录只保留 remote assets：

```text
<shared-root>/<TARGET_OUTPUT_DIR>/
  macos-arm64/
  macos-x64/
  windows-x64/
  windows-arm64/
  linux-x64/
  linux-arm64/
  manifest-*.json
  components/
```

每个 `<platform>-<arch>/` 子目录内只放对应平台架构的安装包、blockmap、`latest*.yml` 和该目录自己的 `manifest.json`。远程 runtime 的 `manifest-*.json` 与 `components/` 继续保留在 release 根目录，供 `release:upload:macos:arm64` 附带上传。

## 读取规则

- `release:upload:macos:*` 读取 `macos-* /` 对应子目录。
- `release:upload:macos:arm64` 额外通过 `EXTRA_UPLOAD_SOURCE_DIR` 读取 release 根目录中的 remote assets。
- `release:upload:windows:*` 读取 `windows-* /` 对应子目录。
- `release:upload:linux:*` 读取 `linux-* /` 对应子目录。
- `release:preload:cdn` 同时依赖 macOS、Windows、Linux 的 x64/arm64 上传结果，确保服务端 manifest 发布前平台/架构目录已经完成 CDN 预热。
- `release:publish:gray` 与 `release:publish:stable` 只消费 upload 阶段产出的 `release-meta-*.json`，不再回读共享目录或上传 stable feed。

## 验证点

- 每个平台 build job 只能把安装包、blockmap、`latest*.yml` 和 `manifest.json` 写入对应平台架构目录。
- 复用共享目录时，build job 必须清理根目录历史安装包副本，但不能删除 remote assets 的 `manifest-*.json` 和 `components/`。
- upload job 的 `SOURCE_DIR` 必须指向平台架构子目录。
- remote assets 上传继续读取 release 根目录下的 `manifest-*.json` 和 `components/`。
