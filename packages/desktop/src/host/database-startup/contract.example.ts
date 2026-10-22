import { tasksStorageWorkerDataSchema } from "./contract.js";
/** 宿主构造 Worker 输入；文件路径保持原值，真实打开与迁移只发生在 Worker。 */
export const exampleWorkerData = tasksStorageWorkerDataSchema.parse({
  path: "./tasks-index.sqlite",
});
