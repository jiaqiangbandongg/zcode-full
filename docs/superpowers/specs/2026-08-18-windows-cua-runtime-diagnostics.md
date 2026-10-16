# Windows CUA 运行时诊断与「陈旧安装」陷阱

日期：2026-08-18
状态：已落地
关联：`docs/cua/windows-product-runtime.md`（发布契约本体）

## 1. 起因与结论

本次任务的初始判断是「pin 到 72a8487d 的 producer 把 Windows 宿主层删了」。**这个判断是错的**，
正确结论是：

> `node_modules/@zcode/zcode-cua` 停在 pin 之前的旧提交，仓库源码本身没有问题。
> 按 lockfile 重装后，未经改动的源码 `tsc` 零错误，`prepare:windows-cua-helper` 正常出包。

记下来是因为这个陷阱会重复发生：`@zcode/zcode-cua` 是 git 依赖，**改 pin 不会自动重装**。

## 2. 误判是怎么发生的

审计时读的是 `node_modules/@zcode/zcode-cua`，把它当成了「pin 指向的内容」。二者当时并不一致：

```
pnpm-workspace.yaml  catalog: ...zcode-cua.git#72a8487d   ← 声明
pnpm-lock.yaml       resolution: {commit: 72a8487d}       ← 锁定（一致）
node_modules/...     ← 实际安装：8/10 装的旧提交（不一致）
```

于是同一个符号在两处结论相反：

| 事实 | node_modules（旧） | producer main@72a8487d（真） |
|---|---|---|
| `package.json.zcodeCuaRuntime` | 无 | **有** |
| `dist/windows-helper.js` | 无 | **有（已入库）** |
| `WINDOWS_DEV_CONTROL_PROTOCOL` | 无导出 | **有**（`windowsDevHelperMain.ts:17`） |
| `ports.ts` 的 controller 端口 | 无 | **有**（`CuaController*` + take/stop） |

那 8 个 TS 错误全部由此而来，不是 producer 回归。基于错误前提的改动已由
`b99a74dbdf` 整体回退（被误删的 controller 端口和协议常量单源引入均已还原）。

### 判别方法（下次先做这一步）

```sh
# 安装与 pin 是否一致：files 字段、版本、关键 artifact 三选一即可证伪
node -e "console.log(JSON.stringify(require('./node_modules/@zcode/zcode-cua/package.json').zcodeCuaRuntime))"
ls node_modules/@zcode/zcode-cua/dist/windows-helper.js
```

任何一项与 producer 仓库同 SHA 的内容对不上，先 `pnpm install --frozen-lockfile`，
**不要**直接在消费端删接口去迁就它。CI 每次从 lockfile 干净安装，所以这类假象只在本地出现——
按假象改仓库，等于把本地环境问题固化进代码。

## 3. 本次实际保留的两项改进

两项都与上面的误判无关，是独立成立的可诊断性缺口。

### 3.1 运行时解析失败落日志

`resolveWindowsCuaRuntime` 有 13 个稳定失败原因（`missing-native-addon` /
`artifact-integrity-mismatch` / `incompatible-runtime-manifest` …），此前全部被
`createWindowsCuaHelperHost` 原样透给调用方后咽掉：用户只看到设置页「未加载」。

```
start() ──▶ getHost ──▶ resolveRuntime() ──✗ reject
                             │                 │
                             │                 └─▶ logger.error(reason, artifact, …)  ← 新增
                             ▼
                        （缓存 rejection）
start() 再次调用 ──▶ 复用同一条 promise ──▶ 不重复落日志
```

- `catch` 只包住 `resolveRuntime()` 本身。其后 `then` 里的 `assertActive` 抛出是 `stop()` 竞态，
  不是解析失败，混进同一条日志会误导。
- 载荷仅 `reason / artifact / errorName / message`。解析发生在 mint token 与命名管道之前，
  载荷天然不含密钥；用例把这条时序保证钉成了回归断言。
- `createWindowsCuaHelperHost` 因此需要导出（供测试注入 logger 与桩 host）。

### 3.2 构建期契约报错自证身份

`readProducerRuntimeContract` 原来把十一个条件挤在一个 `if` 里，只抛一句
`invalid zcodeCuaRuntime Windows artifact path contract`。现在拆成逐条判定，报错含
**包名@版本、源目录、具体不满足项**（缺 `zcodeCuaRuntime` / `schema` 不对 / 路径非法）。

价值恰好由本次事故印证：如果当初报错就说清「`@zcode/zcode-cua@0.5.2` 于
`<路径>`：`zcodeCuaRuntime is missing`」，陈旧安装会当场暴露，不会被误读成 producer 回归。

### 3.3 标准 dev 启动补上 Windows 侧的 runtime 根

`scripts/dev-desktop-env.mjs` 一直为 macOS 注入 `ZCODE_CUA_BUNDLED_HELPER_APP_PATH`
（绑定本 checkout 构建出的 Helper.app），Windows 什么都不注入。于是 host 落到产品分支去读
`process.resourcesPath`——dev 下那是 `node_modules/electron/dist/resources`，实测只有
`default_app.asar`：

```
                     ┌ macOS：ZCODE_CUA_BUNDLED_HELPER_APP_PATH → checkout 内 Helper.app  OK
pnpm dev:desktop ────┤
                     └ Windows：无注入 → resourcesPath = electron/dist/resources
                                        → 无 tools/cua-helper → invalid-runtime-manifest  FAIL
```

结果标准 dev 启动的 Windows computer use 恒不可用，只能靠开发者自己记得设
`ZCODE_CUA_DEV_ROOT`（`docs/cua/windows-source-development.md` 有写，但那是 source 开发手册，
不是每次跑 dev 的人都会读）。

新增 `scripts/dev-desktop-cua-env.mjs`，缺省把 `ZCODE_CUA_DEV_ROOT` 绑到
`<repo>/node_modules/@zcode/zcode-cua`，即 catalog pin 指向的那一版、与产品 staging 同源。
边界：

- 开发者显式设置时**永远**尊重其取值（指向自己的 producer checkout 的场景不变）；
  纯空白与 runtime 侧一致地视为未配置。
- 只补 dev 启动脚本的缺省，不动 runtime 侧「只认 `ZCODE_CUA_DEV_ROOT`、不搜索相邻目录、
  不回退安装包资源」的既有边界。
- 依赖仓库 `.npmrc` 的 `node-linker=hoisted` 让该路径是物理目录。换 isolated linker 时它是
  symlink，解析按 `development-root-not-found` fail closed，并由 3.1 的日志说明原因。


## 4. 复核过、确认「不是差距」的项

- **orphan reaper 只在 darwin 跑**：正确。Windows 子进程有 `--parent-pid` watchdog 兜底，
  不需要开机扫描残留。
- **installer 只在 darwin**：正确。Windows 走安装包内 `resources/tools/cua-helper`，无下载源。
- **Windows 设置面只有开关一项**：由 `2026-08-17-cua-settings-surface-minimization.md` 锁定。
  把 runtime reason 端到 UI 属于推翻那份 spec，需单独评审，本次未动。
