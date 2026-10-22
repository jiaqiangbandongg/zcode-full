/**
 * 格式注册表（src/adapters/parsers.ts、ui/viewers/registry.ts）每种格式一行，行尾标 `// kind:<format>`；
 * 只保留插件声明的格式行，未标记的行原样保留。
 *
 * 按 /\r?\n/ 拆行：.gitattributes 不约束 .ts 换行，Windows 检出为 CRLF 时行尾残留 \r，
 * `$` 锚定的标记匹配全部落空，单格式插件（如 Word）会打进全部渲染器、解析器及其依赖。
 */
export function keepKindLines(source, kinds) {
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const kind = / \/\/ kind:(\w+)$/.exec(line)?.[1];
      return !kind || kinds.includes(kind);
    })
    .join("\n");
}
