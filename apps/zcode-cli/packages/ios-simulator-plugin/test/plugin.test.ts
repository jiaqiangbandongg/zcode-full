import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "vitest"
import { pickAppProduct } from "../src/providers/build.js"
import { create, source } from "../src/providers/project.js"
import { isIosRuntime, parseSimulators } from "../src/providers/sim.js"

const found = {
  projects: ["Explicit.xcodeproj"],
  workspaces: ["Auto.xcworkspace"],
  schemes: ["AutoScheme"],
  bundleIds: [],
}

test("source prefers explicit project over auto workspace", () => {
  expect(source({ project: "Explicit.xcodeproj" }, found)).toEqual({
    flag: "-project",
    file: "Explicit.xcodeproj",
    scheme: "Explicit",
  })
})

test("create validates inputs and refuses accidental overwrites", async () => {
  await withCwd(async () => {
    const created = await create({ name: "Counter App", deployment: "17.0" })
    expect(created.project).toBe(path.join("CounterApp", "CounterApp.xcodeproj"))
    expect(created.bundle).toBe("com.example.counterapp")

    await expect(create({ name: "Counter App" })).rejects.toThrow("Refusing to overwrite")
    await expect(create({ name: "Escaped", dir: "../Escaped" })).rejects.toThrow("Path escapes project root")
    await expect(create({ name: "BadDeploy", deployment: "17.0; BAD=1" })).rejects.toThrow("Invalid deployment")
    await expect(create({ name: "BadBundle", bundleId: "com.example.bad_bundle" })).rejects.toThrow("Invalid bundle id")
  })
})

test("build product selection prefers the requested configuration", () => {
  const debug = path.join("DerivedData", "Build", "Products", "Debug-iphonesimulator", "Demo.app")
  const release = path.join("DerivedData", "Build", "Products", "Release-iphonesimulator", "Demo.app")

  expect(pickAppProduct([debug, release], "Release")).toBe(release)
  expect(pickAppProduct([debug], "Release")).toBe(debug)
})

test("runtime filtering keeps only iOS simulator runtimes", () => {
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.iOS-18-2")).toBe(true)
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.iPadOS-18-2")).toBe(true)
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-18-2")).toBe(false)
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.watchOS-11-2")).toBe(false)
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.visionOS-2-2")).toBe(false)
})

test("simulator parsing drops non-iOS runtimes and unavailable devices", () => {
  const sims = parseSimulators(
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [
          { name: "Apple TV", udid: "TV-1", state: "Shutdown", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
          { name: "iPhone 16", udid: "IOS-1", state: "Shutdown", isAvailable: true },
          { name: "iPhone 15", udid: "IOS-2", state: "Shutdown", availabilityError: "runtime unavailable" },
        ],
      },
    }),
  )

  expect(sims).toEqual([
    {
      name: "iPhone 16",
      udid: "IOS-1",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      available: true,
    },
    {
      name: "iPhone 15",
      udid: "IOS-2",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      available: false,
    },
  ])
  expect(sims.filter((item) => item.available)).toHaveLength(1)
})

async function withCwd(work: () => Promise<void>) {
  const old = process.cwd()
  const dir = await mkdtemp(path.join(tmpdir(), "ios-plugin-test-"))
  process.chdir(dir)
  try {
    await work()
  } finally {
    process.chdir(old)
    await rm(dir, { recursive: true, force: true })
  }
}
