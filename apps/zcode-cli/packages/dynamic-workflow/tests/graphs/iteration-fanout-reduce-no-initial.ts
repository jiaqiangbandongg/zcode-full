// reduce WITHOUT an initial value: at runtime the accumulator starts as parts[0]
// (the glob result), so the checker ask's instructions carry world-read#1.
// Expected: source -> world-read#1; world-read#1 -> fan-out#1;
//           world-read#1 -> ask#1 (MUST); fan-out#1 -> ask#1; sink edges from
//           world-read#1/fan-out#1 (the reduce result reaches the return).
const parts = await files.glob("*.md");
const first = parts.reduce((acc, _part) => {
  agent("checker").ask<string>(`check ${acc}`);
  return acc;
});
return first;
