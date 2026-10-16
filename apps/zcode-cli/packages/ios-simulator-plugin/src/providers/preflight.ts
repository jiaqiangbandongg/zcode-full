import { brief, ok, run } from "../lib/run.js"
import { parseSimulators } from "./sim.js"

type Check = {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

export async function preflight() {
  const checks: Check[] = []
  checks.push({
    name: "macOS",
    ok: process.platform === "darwin",
    detail: process.platform,
    fix: "Run this plugin on macOS with full Xcode installed.",
  })

  const select = await run(["xcode-select", "-p"], { timeout: 10_000 })
  const dir = select.stdout.trim()
  const clt = dir.includes("/CommandLineTools")
  checks.push({
    name: "xcode-select",
    ok: ok(select) && !clt,
    detail: ok(select) ? dir : brief(select),
    fix: "Install full Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
  })

  const build = await run(["xcodebuild", "-version"], { timeout: 10_000 })
  checks.push({
    name: "xcodebuild",
    ok: ok(build),
    detail: brief(build),
    fix: "Open Xcode once and accept license/components. CommandLineTools alone is not enough.",
  })

  const simctl = await run(["xcrun", "simctl", "help"], { timeout: 10_000 })
  checks.push({
    name: "simctl",
    ok: ok(simctl),
    detail: brief(simctl),
    fix: "Install full Xcode and make sure xcrun can find simctl.",
  })

  const devices = await run(["xcrun", "simctl", "list", "devices", "--json"], { timeout: 20_000 })
  const available = ok(devices) ? readAvailableDevices(devices.stdout) : []
  checks.push({
    name: "simulator devices",
    ok: ok(devices) && available.length > 0,
    detail: ok(devices) ? `${available.length} available iOS/iPadOS simulator(s)` : brief(devices),
    fix: "Install an iOS Simulator runtime from Xcode > Settings > Platforms.",
  })

  const ui = process.env.IOS_SIM_UI_BACKEND || "auto"
  const idb = await run(["idb", "--version"], { timeout: 5000 })
  checks.push({
    name: "ui backend",
    ok: ui === "none" || ok(idb) || ui === "auto",
    detail: ok(idb) ? `idb ${idb.stdout.trim()}` : `backend=${ui}; idb unavailable`,
    fix: "P0 build/run/screenshot works without UI backend. Install idb later for tap/swipe/type.",
  })

  return {
    ok: checks.every((item) => item.ok),
    checks,
  }
}

function readAvailableDevices(value: string) {
  try {
    return parseSimulators(value).filter((item) => item.available)
  } catch (err) {
    return []
  }
}
