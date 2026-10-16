import { spawn as spawnChild, type ChildProcess } from "node:child_process"

export type Run = {
  cmd: string[]
  code: number
  stdout: string
  stderr: string
  timed: boolean
}

type RunOpts = {
  cwd?: string
  env?: Record<string, string | undefined>
  timeout?: number
}

export async function run(cmd: string[], opts: RunOpts = {}): Promise<Run> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...(opts.env ?? {}) }).filter((item): item is [string, string] => {
      return typeof item[1] === "string"
    }),
  )
  const child = spawn(cmd, opts.cwd, env)
  if (child instanceof Error) {
    return {
      cmd,
      code: 127,
      stdout: "",
      stderr: child.message,
      timed: false,
    }
  }
  const timeout = opts.timeout ?? 120_000
  let timed = false
  let spawnError: Error | undefined
  const timer = setTimeout(() => {
    timed = true
    child.kill("SIGTERM")
  }, timeout)
  const out = collect(child.stdout)
  const err = collect(child.stderr)
  const code = await new Promise<number>((resolve) => {
    let settled = false
    const settle = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exitCode)
    }

    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error))
      settle(127)
    })
    child.once("close", (exitCode) => settle(exitCode ?? 1))
  })
  const stdout = await out
  const stderr = await err
  return {
    cmd,
    code,
    stdout,
    stderr: spawnError ? [stderr.trim(), spawnError.message].filter(Boolean).join("\n") : stderr,
    timed,
  }
}

function spawn(cmd: string[], cwd: string | undefined, env: Record<string, string>): ChildProcess | Error {
  const [command, ...args] = cmd
  if (!command) return new Error("Missing command")
  try {
    return spawnChild(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

async function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return ""
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString("utf8")
}

export function ok(item: Run): boolean {
  return item.code === 0 && !item.timed
}

export function brief(item: Run, limit = 4000): string {
  const text = [item.stdout.trim(), item.stderr.trim()].filter(Boolean).join("\n")
  if (text.length <= limit) return text
  return text.slice(0, limit) + "\n...[truncated]"
}
