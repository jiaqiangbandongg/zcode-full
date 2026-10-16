import { brief, ok, run } from "../lib/run.js"

type Sim = {
  name: string
  udid: string
  state: string
  runtime: string
  available: boolean
}

const UDID = /^[0-9A-Fa-f-]{8,}$/

function valid(udid: string): boolean {
  return UDID.test(udid)
}

export async function list(): Promise<Sim[]> {
  const out = await run(["xcrun", "simctl", "list", "devices", "--json"], { timeout: 20_000 })
  if (!ok(out)) throw new Error(brief(out))
  return parseSimulators(out.stdout)
}

export function parseSimulators(value: string): Sim[] {
  const raw = JSON.parse(value) as { devices?: Record<string, unknown[]> }
  return Object.entries(raw.devices ?? {}).flatMap(([runtime, devices]) => {
    if (!isIosRuntime(runtime)) return []
    return devices
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        name: String(item.name ?? ""),
        udid: String(item.udid ?? ""),
        state: String(item.state ?? ""),
        runtime,
        available: item.isAvailable !== false && item.availabilityError === undefined,
      }))
      .filter((item) => item.name && item.udid)
  })
}

export function isIosRuntime(runtime: string): boolean {
  return /(?:^|[.\s-])(iOS|iPadOS)(?:$|[.\s-])/.test(runtime)
}

export async function pick(input?: { udid?: string; name?: string; runtime?: string }): Promise<Sim> {
  if (input?.udid) {
    if (!valid(input.udid)) throw new Error(`Invalid simulator UDID: ${input.udid}`)
    const hit = (await list()).find((item) => item.udid === input.udid)
    if (hit) return hit
    throw new Error(`Simulator not found: ${input.udid}`)
  }
  const sims = (await list()).filter((item) => item.available)
  const booted = sims.find((item) => item.state === "Booted")
  if (booted && !input?.name && !input?.runtime) return booted
  const want = (input?.name || process.env.IOS_SIM_DEFAULT_DEVICE || "iPhone 16").toLowerCase()
  const found = sims.find((item) => {
    return item.name.toLowerCase().includes(want) && (!input?.runtime || item.runtime.includes(input.runtime))
  })
  if (found) return found
  const phone = sims.find((item) => item.name.startsWith("iPhone") && (!input?.runtime || item.runtime.includes(input.runtime)))
  if (phone) return phone
  const first = sims[0]
  if (first) return first
  throw new Error("No available iOS simulators found.")
}

export async function boot(input: { udid?: string; name?: string; runtime?: string; open?: boolean } = {}) {
  const sim = await pick(input)
  if (sim.state !== "Booted") {
    const out = await run(["xcrun", "simctl", "boot", sim.udid], { timeout: 60_000 })
    if (!ok(out) && !brief(out).includes("current state: Booted")) throw new Error(brief(out))
    const ready = await run(["xcrun", "simctl", "bootstatus", sim.udid, "-b"], { timeout: 120_000 })
    if (!ok(ready)) throw new Error(brief(ready))
  }
  if (input.open) await show(sim.udid)
  return { ...(await pick({ udid: sim.udid })), opened: Boolean(input.open) }
}

export async function show(udid?: string) {
  const args = udid ? ["open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid] : ["open", "-a", "Simulator"]
  const out = await run(args, { timeout: 10_000 })
  if (ok(out)) return { opened: true, udid }
  const fallback = await run(["open", "-a", "Simulator"], { timeout: 10_000 })
  if (ok(fallback)) return { opened: true, udid, fallback: true }
  throw new Error(brief(out) || brief(fallback))
}

export async function install(udid: string, app: string) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  const out = await run(["xcrun", "simctl", "install", udid, app], { timeout: 120_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { installed: true, udid, app }
}

export async function launch(udid: string, bundle: string, args: string[] = []) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  const out = await run(["xcrun", "simctl", "launch", udid, bundle, ...args], { timeout: 60_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { launched: true, udid, bundle, output: brief(out) }
}

export async function terminate(udid: string, bundle: string) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  const out = await run(["xcrun", "simctl", "terminate", udid, bundle], { timeout: 30_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { terminated: true, udid, bundle }
}

export async function url(udid: string, value: string) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  if (value.length > 2048) throw new Error("URL is too long.")
  const out = await run(["xcrun", "simctl", "openurl", udid, value], { timeout: 30_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { opened: true, udid, url: value }
}
