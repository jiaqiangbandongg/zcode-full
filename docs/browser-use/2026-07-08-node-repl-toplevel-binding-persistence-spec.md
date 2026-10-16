# node_repl 顶层绑定跨调用持久（路线 B，A-ready 接缝）设计

日期：2026-07-08　状态：已实现（路线 B，commit 9c5472724 T1 / ae5742031 T2 / 69336b1b1 T3；core 测试通过。文档状态头此前滞后，特此更正）

## 1. 背景与目标

真机 trace（sess_91161ac5）复现：模型写 `const tab = await agent.browsers.open(...)`，下一次 `js` 调用引用 `tab` → `ReferenceError: tab is not defined`。根因：`NodeReplSession.run` 为支持 top-level await 把代码包进 `(async () => { ... })()`，顶层 `const/let/var/function` 被 IIFE 局部作用域捕获、不落持久 vm context，只有 `globalThis.x =` 能跨调用留存。

让顶层绑定跨调用持久的完整做法（下称路线 A）是：**meriyah.parseModule 解析 → instrument 顶层声明 → `vm.SourceTextModule` 在持久 `vm.createContext` 里跑（ESM 原生 TLA，需 `--experimental-vm-modules`）→ 从 `module.namespace` 收割绑定**。

目标：让模型写 `const tab = ...` 就能跨 `js` 调用复用（消除此类 not-defined）。采**路线 B（免 `--experimental-vm-modules` flag）**：保留 async-IIFE 拿 TLA，但用 parser 把顶层声明 instrument 成"复制到持久 context"。同时把接缝留好，将来若能加 flag 可低成本升级到**路线 A（SourceTextModule）**。

不选 A 首发的原因：`vm.SourceTextModule` 强依赖 `--experimental-vm-modules`，而 zcode 打包态 agent 走 `ELECTRON_RUN_AS_NODE`，加 flag 未验证；B 零 flag、风险低，且是 A 不可行时的稳定落点。

## 2. 路线 B 机制

对每次 `js` 代码：
1. **解析**：`meriyah`（ESTree；`ecmaVersion:"latest"`, `allowAwaitOutsideFunction:true`, `allowReturnOutsideFunction:true`）解析原始代码拿 AST。解析失败 → 回退到"原样包 async-IIFE 执行"（保持现有行为，不因 instrument 崩）。
2. **收集顶层绑定名**：遍历 `ast.body`，对 `VariableDeclaration`/`FunctionDeclaration`/`ClassDeclaration` 收集绑定名，含**解构**（ObjectPattern/ArrayPattern/RestElement/AssignmentPattern）。（本阶段不处理 `for`/`for-of` 的 init/left——那些声明本就是循环局部、模型极少需要跨调用复用；A 阶段可补齐。）
3. **instrument**：在每条顶层声明语句**之后**注入 `globalThis.<name> = <name>;`（把刚声明的绑定复制到持久 context）。用不易冲突的写法逐名赋值。
4. **包裹执行**：`(async () => {\n<instrumented code>\n})()`，`runInContext` 于持久 context（现状不变）。下次调用里 bare `tab` 经作用域链解析到 `globalThis.tab`，即得持久。

### 语义说明（与路线 A 的差异，可接受）
- 路线 A（SourceTextModule）保留真 `const` 的 TDZ 与"跨调用重声明报错"；B 里同名 `const` 在新调用的 IIFE 内是新局部、**遮蔽** globalThis 同名，不报错（更宽松）。对模型使用无害，A 阶段自然获得更严格语义。
- 仅顶层声明持久；块内/函数内声明不持久（符合预期）。

## 3. A-ready 接缝（关键：B→A 只换执行器，不重写）

新增 `packages/core/src/repl/instrument.ts`，纯函数、可独立单测：
- `parseReplCode(code): { ast } | { parseError }` —— 封装 meriyah.parseModule（parser 换实现只动这里）。
- `collectTopLevelBindingNames(ast): string[]` —— 遍历顶层声明+解构收集绑定名。**A 直接复用**。
- `instrumentForContextPersistence(code, ast): string` —— 路线 B 的重写（注入 globalThis 赋值）。A 另写 `instrumentForModuleHarvest` 复用 `collectTopLevelBindingNames`。

`NodeReplSession` 把"执行+持久"藏在一个内部策略后：
- `interface ReplExecutor { run(code, context, signal?): Promise<{ result?, error? }> }`
- B 实现 `IifeContextExecutor`：instrument → async-IIFE → runInContext。
- A 将来实现 `SourceTextModuleExecutor`：instrument(harvest 版) → SourceTextModule.evaluate → 收割 namespace。
- `NodeReplSession.run()` 只调 `this.executor.run(...)`，切换 executor 即切路线，主体不动。

## 4. 依赖
- 给 `apps/zcode-cli/packages/core` 加 `meriyah`（零依赖、ESTree 兼容、随 tsup 打包）。

## 5. 实现任务（TDD）
- **T1**：`instrument.ts` 三个纯函数 + 单测：`collectTopLevelBindingNames` 覆盖 `const a`、`let a,b`、`var`、解构 `const {x,y}=o` / `const [p,[q]]=arr` / rest、`function f(){}`、`class C{}`；忽略块内/函数内声明。`instrumentForContextPersistence` 断言注入了 `globalThis.a=a` 等；解析失败路径。
- **T2**：`ReplExecutor` 接口 + `IifeContextExecutor`；`NodeReplSession.run` 改走 executor。单测（现有 node-repl-session 测试 + 新增）：`const tab=1`（call1）→ 下一次 `tab`（call2）读到 1；解构持久；top-level await 仍工作；块内 `const` 不持久；parse 失败回退仍能跑；reset 清空。
- **T3**：文档回滚——`documentation()` 与 `js` 工具描述改回示范 `const tab = await agent.browsers.open(url)`（跨调用可用），移除"用 globalThis"的过渡说明（B 落地后 const 已能持久）。

## 6. 影响文件
- 新增 `apps/zcode-cli/packages/core/src/repl/instrument.ts` + 测试
- 改 `apps/zcode-cli/packages/core/src/repl/node-repl-session.ts`（executor 接缝 + run 走 instrument）
- 改 `apps/zcode-cli/packages/core/src/browser-client/facade.ts`（documentation 回滚 const 示范）
- 改 `apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts`（js 描述回滚）
- `apps/zcode-cli/packages/core/package.json`（加 meriyah）
