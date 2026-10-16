# Post-Update Release Notes

发布日志由 infra 通过 API 直接编辑 runner 共享目录中的 `latest.yml`，并保留 electron-updater 兼容的 `releaseName` / `releaseNotes`。z-code CI 不再生成单版本 `changelogs/vX.Y.Z*.md`、不读取根目录 `CHANGELOG.md` 注入日志，也不生成独立的 `latest-en.yml`；approve 放行后先校验共享目录中的清单，校验通过后才上传。

自动更新下载完成后，main 进程会把当前版本说明持久化到 `pendingPostUpdateReleaseNotes`，并把同一份 payload 随 `update-downloaded` 状态广播给 renderer。左上角更新按钮 hover 时按当前 UI 语言选择 `releaseNotesByLocale` 中的 Markdown 展示；若旧 feed 没有多语言字段，则回退到默认 `releaseNotes`。如果用户尚未安装就重启应用，且 pending 版本仍高于当前应用版本，main 会用这份 payload 恢复待安装状态，但不会提前把它作为安装后的说明发给 renderer 确认。

若用户未通过本次自动更新链路安装（例如官网安装包跳级升级），磁盘里可能仍残留**更低版本**的待展示说明；启动时若 semver 判定该版本低于当前 `app.getVersion()`，会丢弃该 pending，避免弹出旧版更新日志。

当前 Root 收到安装后待展示说明时会静默 ack，避免弹窗打断用户。Markdown 渲染沿用现有消息渲染能力。
