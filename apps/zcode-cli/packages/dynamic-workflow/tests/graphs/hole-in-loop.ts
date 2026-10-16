// A hole in a plain `for` loop (hole-in-for-of covers the for...of form): one step,
// reached per round with that round's bindings, its result carried into the next round's
// `fixes`. The fill is written once and its body runs per reach.
interface Fix {
  patch: string;
}
const paths = await files.glob("src/**/*.ts");
const fixes: string[] = [];
for (let i = 0; i < paths.length; i += 1) {
  const note = await agent(`审查-${i}`).ask<string>(`审查 ${paths[i]}`);
  const fix = await hole<Fix>("决定修法", `第 ${i} 个文件 ${paths[i]}：${note}`);
  fixes.push(fix.patch);
}
return fixes;
