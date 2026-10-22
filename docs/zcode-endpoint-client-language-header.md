# ZCode Endpoint Client Language Header

## 背景

ZCode endpoint 请求的 `X-Client-Language` 以前取进程的 `Intl.DateTimeFormat().resolvedOptions().locale`。
App 从 Finder/Dock 启动时进程没有 `LANG`，Node ICU 回退为 `en-US`；即使有 `LANG`，它也只代表系统语言，
不跟随界面语言设置。结果是 `billing/balance`、`client/configs` 等请求在中文界面下仍发送 `en-US`。

`marketing/touch` 不受影响：UI 把 `useZCodeIntl().locale` 作为参数传给服务，服务显式写入该 header，
覆盖 `NodeApiClient` 的默认值。

## 状态 owner

实时界面语言的 owner 是 UI 状态；Main 通过 `SetApplicationLocale` 立即收到，保存在
`currentApplicationLocale`（菜单、托盘等已经使用它）。`setting.json` 的 `locale` 只用于重启恢复：
写入是异步的，失败不阻断 UI，所以不能作为实时请求的来源。

```text
UI locale ──立即──> Main.currentApplicationLocale（实时 owner）
   │                  ├─ Main 自身请求：client/configs 灰度、帮助配置
   │                  ├─ spawn Host：InitLocal.locale（初值）
   │                  └─ 切换时：向所有窗口 Host post application-locale-changed
   │                        └─ Host 内存 clientLocale ──同步读──> NodeApiClient 默认来源头
   └─异步、可失败──> setting.json（重启恢复）
```

## 规则

- Host 只读内存值，不做 I/O；语言读取不会影响请求的取消与超时。
- InitLocal 与变更消息走同一个 utility process 端口，按发送顺序到达，初值不会覆盖较新的变更。
- Main 启动时先读取持久化语言（缺失时用系统语言），再启动 client/configs 灰度预热，
  预热请求不会带默认语言进入 1 小时缓存。
- 调用方显式传入的 `X-Client-Language` 仍然优先（`marketing/touch` 行为不变）。
- 没有收到语言时，回退到原有 `Intl` 规则，不阻断请求。
- 远端 `zcode-server`（SSH/WSL/Docker）不注入，保持原有 `Intl` 行为；远端同步另行设计。

## 测试覆盖

E2E：`packages/desktop/test/e2e/settings/settings-client-language-header.test.ts`。用 `x-request-id`
区分 Host（`NodeApiClient`）和 Main（Electron `net`）的 `client/configs` 请求。

| Case   | 场景                                                                 | 断言                                                           |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| CLH-01 | 持久化 `en-US`（不同于启动默认 `zh-CN`）后重启 App                   | 启动预热与 Host 请求都带 `en-US`                               |
| CLH-02 | 第二个窗口的 Host 写 `setting.json` 失败；在该窗口设置页切到 `zh-CN` | 两个窗口的 Host 与 Main 的新请求都带 `zh-CN`；磁盘仍是 `en-US` |

E2E 无法稳定守住的约束：

- InitLocal 初值：渲染进程挂载时会把语言同步给 Main，Main 再推给 Host，挂载后的请求看不出差别（反向修改已实测）。
  由 `desktopWindowLifecycle.test.ts` 覆盖下发；Host 消息校验由 `hostMessagePortGuard.test.ts` 覆盖。
- 预热晚于读取持久化语言：预热读语言前还有两次 `await`，正常时序下启动读取先完成，竞态无法复现（反向修改已实测）；
  只靠 `main/index.ts` 中的调用顺序保证。
- Host 初始化期间收到变更：同样会被挂载后的同步掩盖（推断，未实测）。顺序由「消息处理在任何 `await` 之前同步赋值」保证。
- 只推给发起窗口的 Host：其他窗口的渲染进程收到语言广播后也会各自同步给 Main，用户可见行为不变（推断，未实测）。

## 未覆盖

- 远端 `zcode-server` 发起的请求。
- `offPeakServerClient` 直接 `fetch`，仍用 `Intl` 规则。
- CLI（`apps/zcode-cli`）的 provider endpoint routing 与 standalone Built-in 下载。
