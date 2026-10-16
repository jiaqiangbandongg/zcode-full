# knip.dev（上游源码快照）

> 本目录是 Knip V6 文档站源码的裁剪镜像，不属于 ZCode workspace，也不能在当前仓库独立
> 构建。generator 依赖的上游 monorepo 路径和部分插件页面没有随镜像复制。项目实际行为以
> 根目录安装的 Knip 版本、配置和命令输出为准。

The source of [knip.dev][1].

[1]: https://knip.dev

## 来源与许可

- 上游仓库：[webpro-nl/knip](https://github.com/webpro-nl/knip)，原目录 `packages/docs`。
- 核验版本：Knip 6.0.6，上游提交 [`d5d20e5e21d64590c0e735c6bc840295cda665cd`](https://github.com/webpro-nl/knip/tree/d5d20e5e21d64590c0e735c6bc840295cda665cd/packages/docs)。原始导入的 169 个文件与该提交对应文件的 Git blob SHA-1 全部一致；原始导入操作没有记录上游 revision，此处记录内容比对确认的参考版本，不宣称它是唯一可能的来源提交。后续本地修改包括本 README 的镜像说明与许可材料。
- Knip 原有源码与文档使用 ISC，原始版权及许可全文保存在 [LICENSE](LICENSE)，取自上述固定提交的根 `license` 文件。
- 镜像内字体保留各自许可，不由 Knip 的 ISC 许可替代：
  - `public/fonts/SourceSansPro-Regular.otf`：字体内版本为 2.020，对应 [Source Sans Pro 2.020 许可](licenses/SourceSansPro-2.020-LICENSE.txt)，SIL OFL 1.1。
  - `src/fonts/6x*.woff2`：字体内版本分别为 2.045（正体）和 1.095（斜体），对应 [Source Sans Pro 2.045/1.095 许可](licenses/SourceSansPro-2.045-1.095-LICENSE.txt)，SIL OFL 1.1。
  - `src/fonts/hack-regular-subset.woff2`：字体内版本为 3.003，对应 [Hack 3.003 许可](licenses/Hack-3.003-LICENSE.md)，保留 MIT、Bitstream Vera 及 DejaVu 公有领域声明。

上述内容登记在根目录 `third-party/copied-components.json`，固定来源和原文字节哈希随 `THIRD-PARTY-NOTICES.md`、`third-party/inventory.json` 一起生成和校验。更新镜像时应同步核验许可材料。
