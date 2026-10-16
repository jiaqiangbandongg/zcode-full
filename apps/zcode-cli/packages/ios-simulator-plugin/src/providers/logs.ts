import { brief, ok, run } from "../lib/run.js"
import { pick } from "./sim.js"

type Logs = {
  udid?: string
  device?: string
  runtime?: string
  bundleId?: string
  seconds?: number
  limit?: number
}

const ID = /^[A-Za-z0-9_.-]+$/

export async function logs(input: Logs = {}) {
  const sim = await pick({ udid: input.udid, name: input.device, runtime: input.runtime })
  const secs = Math.max(1, Math.min(input.seconds ?? 120, 3600))
  const args = ["xcrun", "simctl", "spawn", sim.udid, "log", "show", "--style", "compact", "--last", `${secs}s`]
  if (input.bundleId) {
    if (!ID.test(input.bundleId)) throw new Error(`Invalid bundle id: ${input.bundleId}`)
    args.push("--predicate", `subsystem CONTAINS "${input.bundleId}" OR process CONTAINS "${input.bundleId.split(".").at(-1)}"`)
  }
  const out = await run(args, { timeout: 60_000 })
  if (!ok(out)) throw new Error(brief(out))
  return {
    simulator: sim,
    seconds: secs,
    output: text(out.stdout, input.limit ?? 20_000),
  }
}

function text(value: string, limit: number): string {
  if (value.length <= limit) return value
  return value.slice(0, limit) + "\n...[truncated]"
}
