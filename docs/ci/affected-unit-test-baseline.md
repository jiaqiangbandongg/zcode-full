# Push 前 affected 单测比较基线

首次推送新分支时，远端 ref 没有可比较的 commit，affected 单测 runner 会回退到默认基线。默认基线优先使用 `origin/staging`，再使用 `origin/HEAD`、`origin/main`、`origin/master`、`main`、`master`。

不再按锁文件、package、Vitest、TypeScript 或门禁脚本等文件名强制执行全量测试。只要存在可用比较基线，就统一根据实际变更运行 affected/related 单测。

只有找不到任何可用基线，或删除了无法交给 Vitest related 分析的源码文件时，才执行全量 `pnpm test:unit`。
