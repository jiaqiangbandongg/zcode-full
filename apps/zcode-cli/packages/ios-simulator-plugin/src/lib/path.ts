import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT_FROM_DIST = "../.."

export async function data(...part: string[]): Promise<string> {
  const dir = path.join(process.env.IOS_SIM_PLUGIN_DATA || path.join(os.tmpdir(), "ios-simulator-plugin"), ...part)
  await mkdir(dir, { recursive: true })
  return dir
}

export function inside(base: string, raw: string): string {
  const out = path.resolve(base, raw)
  if (out === base || out.startsWith(base + path.sep)) return out
  throw new Error(`Path escapes project root: ${raw}`)
}

export function rel(file: string): string {
  return path.relative(process.cwd(), file) || "."
}
