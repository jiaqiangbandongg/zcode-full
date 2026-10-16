// 基础类型、字面量、字面量 union → enum。
interface Basics {
  title: string;
  count: number;
  enabled: boolean;
  nothing: null;
  status: "draft" | "published" | "archived";
  priority: 1 | 2 | 3;
  exact: "only";
}

const worker = agent("worker");
const result = await worker.ask<Basics>("produce the basics artifact");
log(JSON.stringify(result));
