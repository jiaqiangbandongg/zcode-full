# Release changelog body bullets

更新日期：2026-05-08

`npm run release` 使用 `release-it` 生成版本 changelog。发布配置迁移到 `.release-it.mjs`，因为 `@release-it/conventional-changelog` 的 `writerOpts.transform` 和模板需要 JavaScript 函数，JSON 配置无法表达。

生成规则：

- commit header 继续按 Conventional Commits 分组，例如 `feat` 进入 `Features`，`fix` 进入 `Bug Fixes`
- commit body 中形如 `- xxx`、`* xxx`、`+ xxx` 的独立 bullet 会追加到该 commit 条目下面
- 非 bullet 段落不会进入 changelog
- `BREAKING CHANGE` / `BREAKING-CHANGE` 仍交给 conventional changelog 的 notes 机制处理，不作为普通 body bullet 输出

示例：

```text
fix(web-remote): harden mobile reconnect flow

- add safe home-only services
- extend workspace reconnect timeout
```

会生成：

```md
* **web-remote:** harden mobile reconnect flow ([38dd68b](...))
  * add safe home-only services
  * extend workspace reconnect timeout
```

相关实现：`scripts/release-it/changelog-writer.mjs`。
