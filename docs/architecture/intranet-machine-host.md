# Intranet Machine Host

## 背景

内网依赖下载、内网探测、SEA SMB 上传提示和发布通知都需要引用同一台内网机器。过去各脚本各自写默认 IP，机器迁移时容易漏改。

## 规则

- 统一环境变量：`INTRANET_MACHINE_HOST`
- 默认值：`10.0.0.100`
- host 语义只表示机器地址，不包含协议、端口或路径
- 需要完整 URL 的场景继续在调用处按自己的协议、端口和路径拼接
- deps 完整镜像地址仍可用 `ZCODE_DEPS_BASE_URL` 覆盖；该变量覆盖的是完整 deps base URL，不替代 `INTRANET_MACHINE_HOST`

## 覆盖范围

- `packages/shared/src/intranetDefaults.ts`：内网探测默认 host 和 probe URL
- `scripts/intranetDefaults.mjs`：脚本侧 deps base URL 默认 host
- `scripts/download-glm.sh`：Shell 下载脚本默认 host
- `apps/zcode-cli/packages/cli/scripts/upload-sea-smb.mjs`：SMB URL 提示默认 host
- 发布通知脚本：通过同一个 host 组装内网制品 URL 或远程发送地址

## 使用示例

```bash
INTRANET_MACHINE_HOST=192.0.2.10 pnpm bundle:desktop
```
