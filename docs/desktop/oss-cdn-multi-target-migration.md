# OSS/CDN 多目标迁移

## 背景

当前仓库版本已经是 `3.1.2`，因此 CDN/OSS 迁移桥接版从 `3.1.3` 开始。已安装的旧版本会固定读取包内 `app-update.yml` 写入的 generic stable feed，所以旧 CDN 的 stable feed 不能在桥接版前下线。

## CI 变量模型

迁移切换只通过 CI 环境变量完成：

```bash
CDN_DOMAIN=cdn-zcode.z.ai,cdn.zcode-ai.com,cdn.codegeex.cn
OSS_BUCKET=new-bucket,old-bucket-a,old-bucket-b
OSS_PATH_PREFIX=zcode/electron/releases
OSS_CONFIG_FILE=/etc/ossutil/new,/etc/ossutil/old-a,/etc/ossutil/old-b
```

- `CDN_DOMAIN` 支持逗号分隔列表；第一项是打包写入客户端和 release API 使用的主域名。
- `OSS_BUCKET` 支持逗号分隔列表；必须是单值，或与 `CDN_DOMAIN` 数量一致。
- `OSS_PATH_PREFIX` 支持单值复用；如果配置多值，也必须与 `CDN_DOMAIN` 数量一致。
- `OSS_CONFIG_FILE` 可选，支持单值复用，或与 `CDN_DOMAIN` 数量一致；配置后每组 OSS 上传都会用对应的 ossutil 配置文件，便于新旧 OSS 使用不同 AK/SK 和 region。
- 数量不匹配时 CI 必须失败，避免写错 bucket 或路径。

## 版本流程

### 3.1.2

已发布版本，不再修改。旧 CDN/OSS 继续保留 stable feed、安装包、blockmap、`manifest-*.json` 和 `components/**`。

### 3.1.3 桥接版

配置三组目标：

```bash
CDN_DOMAIN=cdn-zcode.z.ai,cdn.zcode-ai.com,cdn.codegeex.cn
OSS_BUCKET=new-bucket,old-bucket-a,old-bucket-b
OSS_CONFIG_FILE=/etc/ossutil/new,/etc/ossutil/old-a,/etc/ossutil/old-b
```

CI 会把 `3.1.3` 的完整产物上传到三组 OSS/CDN，并在 publish 成功后覆盖三组 stable feed。旧 `3.1.2` 客户端继续从旧 feed 升级到 `3.1.3`；升级后的 `3.1.3` 客户端内置主域名 `cdn-zcode.z.ai`，后续走新 CDN。

### 3.1.4 切新

配置单组目标：

```bash
CDN_DOMAIN=cdn-zcode.z.ai
OSS_BUCKET=new-bucket
OSS_CONFIG_FILE=/etc/ossutil/new
```

从 `3.1.4` 开始只上传新 OSS/CDN。旧 CDN 保留 `3.1.3` stable feed 一段时间，兜底长期未启动的 `3.1.2` 用户。

## 每个目标上传内容

每组 `{domain, bucket, pathPrefix}` 都必须有完整产物：

```text
oss://<bucket>/<pathPrefix>/<version>/
  ZCode-...
  latest.yml
  manifest-*.json

oss://<bucket>/<pathPrefix>/components/**

oss://<bucket>/<pathPrefix>/update/<platform>/<arch>/
  updater package
  *.blockmap
```

版本化平台目录内的更新清单统一命名为 `latest.yml`，多语言日志放在 `releaseNotesByLocale`；当前发布链路不再覆盖旧版 stable feed。`manifest-*.json` 必须进入版本目录。

## 验证

- `ci*` 分支先验证三目标上传、预热和 publish。
- 手工验证 `3.1.2 -> 3.1.3` 从旧 feed 升级。
- 手工验证 `3.1.3 -> 3.1.4` 从新 feed 升级。
- 验证 remote runtime 在三组 CDN 都能拉到 `manifest-*.json` 和 `components/**`。
