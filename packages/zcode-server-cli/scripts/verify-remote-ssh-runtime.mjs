import { spawn } from "node:child_process";
import { createServer } from "node:net";

export function run(command, args, { input, allowFailure = false, quiet = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      } else {
        if (!quiet) console.error(stderr || stdout);
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
      }
    });
  });
}

export async function findFreePort() {
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

export async function retry(description, attempts, delayMs, action) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error(`${description} failed after ${attempts} attempts: ${lastError}`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
