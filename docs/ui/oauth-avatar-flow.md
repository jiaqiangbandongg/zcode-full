# OAuth 头像接入

这套实现把登录头像和用户信息一起从 provider 端传到 UI。

## 数据流

1. provider 的 `fetchUserInfo()` 读取第三方 `userinfo` 接口。
2. provider 将头像地址写入 `OAuthUserProfile.avatarUrl`。
3. `OAuthService` 把 `OAuthUserProfile` 转成 `UserInfo` 时保留 `avatarUrl`。
4. `WorkspaceSidebarFooter` 使用 `AvatarImage` 渲染头像，加载失败时回退到首字母或用户图标。

## 当前 provider 映射

- BigModel: `userData.avatar` -> `avatarUrl`
- ZAI: `userData.picture` -> `avatarUrl`

## 约束

- 旧登录态只保存用户名时，头像字段可以缺省，不影响登录恢复。
- 新 provider 需要先确认 userinfo 响应里头像字段名，再补到 `OAuthUserProfile`。
