// Element mutation through the iteration binding. At runtime the forEach callback
// parameter and the for...of loop variable ARE the array elements (references), so a
// field write through them mutates the arrays; the later read of a[0].note / b[0].note
// carries ask#1's artifact into ask#2.
// Expected: source -> ask#1; ask#1 -> ask#2 (MUST); ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
const a = [{ note: "" }];
const b = [{ note: "" }];
a.forEach((x) => {
  x.note = secret;
});
for (const y of b) {
  y.note = secret;
}
return agent("reader").ask<string>(`${a[0]!.note} ${b[0]!.note}`);
