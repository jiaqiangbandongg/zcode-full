import type { GenUiCardTarget } from "./contract.js";
import { collectGenUiSourcePaths, matchesGenUiSourcePath } from "@/gen-ui/contract.js";
export const sourceFileExample = matchesGenUiSourcePath(
  "/work/demo.html",
  collectGenUiSourcePaths('::visualize{"path":"/work/demo.html"}'),
);
export const example: GenUiCardTarget = {
  workspacePath: "/work",
  sessionId: "session",
  path: "/work/demo.html",
  instanceKey: "row:offset",
};
