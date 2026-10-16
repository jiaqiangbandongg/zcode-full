// Labeled break out of nested loops carrying taint into a post-loop read.
const seed = await agent("scan").ask<string[]>("gather");
let found = "";
outer: for (const item of seed) {
  for (const ch of item) {
    found = ch;
    break outer;
  }
}
return agent("act").ask<string>(`act on ${found}`);
