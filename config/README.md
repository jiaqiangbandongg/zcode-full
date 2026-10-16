# 内置默认配置

`config/default.json` 是随客户端发布的默认配置，必须保留。Desktop 从打包文件读取，
Web 在构建时导入；远端请求失败或缺少有效字段时使用内置值。

## 帮助配置来源

新版社群和反馈入口请求当前 endpoint 的 `GET /api/v1/client/configs`，
读取 `data.configs.feedbackUrl`：

- `community_urls["zh-CN" | "en-US"]`：只按当前语言回退到内置入口，不跨语言回退。
- `feedback_url`：远端有效地址优先，否则使用内置地址。
- `feedback_use_external_form`：远端布尔值优先，`false` 也是有效覆盖。

请求携带 `app_version`；Desktop 另带 `platform-arch`，Web 省略平台参数。
成功响应仅做 1 小时内存缓存，请求使用 `cache: no-store`，失败不缓存。

```text
当前 endpoint client/configs -> 有效帮助字段 -> 平台入口
                  | 缺失 / 失败
                  v
          内置 default.json -> 平台入口
```

旧 CDN default.json 仅为旧版客户端兼容保留；新版无请求或 URL 构造链路，
不要因此删除线上旧文件或本目录内置文件。内置文件的其他字段与既有消费者保持不变。

详细规则见 [用户社群入口配置](../docs/ui/settings-community-link-config.md)。
