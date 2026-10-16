interface Answer {
  value: number;
}

const solver = agent("solver");

async function solve(question: string): Promise<number> {
  const a = await solver.ask<Answer>(question);
  return a.value;
}

const x = await solve("2 + 2");
const y = await solve("3 + 3");
return x + y;
