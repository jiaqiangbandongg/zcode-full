// Exercises the embedded ES2022 stdlib closure end to end: if the compiler host
// is missing any lib file, these globals fail to resolve and the fixture (which
// carries no `// error` markers) fails the strict clean-compile check.
interface Item {
  id: number;
  label: string;
}

const collect = async (id: number): Promise<Item> => {
  const label = await agent("worker").ask(`describe ${id}`);
  return { id, label };
};

const ids = Array.from({ length: 3 }, (_unused, index) => index);
const items: Item[] = await Promise.all(ids.map((id) => collect(id)));

const seen = new Set<number>();
const byId = new Map<number, string>();
for (const item of items) {
  seen.add(item.id);
  byId.set(item.id, `${item.label} (#${item.id})`);
}

return JSON.stringify({ count: seen.size, labels: [...byId.values()] });
