// A hole inside a for...of body. The interpreter reads for...of as an iteration candidate, and
// the hole is a facade site, so the candidate promotes to a fan-out and the hole is issued
// inside its region (`within=fan-out#1`) — the per-element semantics for...of always gets.
// That is not the 9012 case: only an ARRAY-METHOD callback rejects a hole, because its
// elements run concurrently; a for...of with await is sequential, so the first round parks
// at the hole, the fill arrives, and every later round runs the body with its own bindings.
interface Fix {
  patch: string;
}
const paths = await files.glob("src/**/*.ts");
const fixes: string[] = [];
for (const path of paths) {
  const note = await agent(`审查-${path}`).ask<string>(`审查 ${path}`);
  const fix = await hole<Fix>("决定修法", `${path}：${note}`);
  fixes.push(fix.patch);
}
return fixes;
