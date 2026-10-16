import { access } from "node:fs/promises";
import { resolve } from "node:path";

await access(resolve(import.meta.dirname, "computer-use-client.mjs"));
