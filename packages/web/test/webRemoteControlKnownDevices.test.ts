import { describe, expect, it } from "vitest";
import type { WebRemoteControlDeviceGroup } from "#src/web-remote-control/index.js";

import {
  KNOWN_DEVICES_KEY,
  KNOWN_DEVICES_LIMIT,
  readKnownDevices,
  rememberKnownDevices,
} from "#src/web-remote-control/index.js";

function memoryStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(KNOWN_DEVICES_KEY, initial);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const onlineGroup = (
  deviceMid: string,
  name?: string,
  platform?: string,
): WebRemoteControlDeviceGroup => ({
  deviceMid,
  name,
  platform,
  onlineConnections: [
    {
      device_sid: `${deviceMid}-sid`,
      device_mid: deviceMid,
      online: true,
      created_at: 1,
      meta: {},
    },
  ],
});

describe("本地记住的设备名与平台", () => {
  it("兼容旧 [mid, name] 二元组，接受 [mid, name, platform]，忽略形状不对的条目并去掉首尾空白", () => {
    const storage = memoryStorage(
      JSON.stringify([
        ["mid-1", " One "],
        ["mid-2"],
        "junk",
        ["mid-3", "   "],
        [3, "x"],
        ["", "empty"],
        ["mid-4", "Four", " darwin "],
        ["mid-5", "", "linux"],
        ["mid-6", "Six", 7],
        ["mid-7", "Seven", "win32", "extra"],
      ]),
    );
    expect([...readKnownDevices(storage)]).toEqual([
      ["mid-1", { name: "One" }],
      ["mid-4", { name: "Four", platform: "darwin" }],
      ["mid-5", { platform: "linux" }],
    ]);
  });

  it("缺失、非数组 JSON、损坏内容或读取抛错都按没有记住任何设备处理", () => {
    expect(readKnownDevices(memoryStorage()).size).toBe(0);
    expect(readKnownDevices(memoryStorage('{"mid-1":"One"}')).size).toBe(0);
    expect(readKnownDevices(memoryStorage("{not json")).size).toBe(0);
    expect(
      readKnownDevices({
        getItem() {
          throw new Error("blocked");
        },
        setItem() {},
      }).size,
    ).toBe(0);
  });

  it("只写入有在线连接且有名字或平台的设备项，再次见到的设备移到最近位置", () => {
    const storage = memoryStorage(
      JSON.stringify([
        ["mid-a", "A"],
        ["mid-b", "B", "win32"],
      ]),
    );
    const known = readKnownDevices(storage);
    rememberKnownDevices(storage, known, [
      onlineGroup("mid-a", "A renamed", "darwin"),
      onlineGroup("mid-c", "C"),
      onlineGroup("mid-d"),
      onlineGroup("mid-p", undefined, "linux"),
      { deviceMid: "mid-e", name: "E (offline, from cache)", onlineConnections: [] },
    ]);
    expect(JSON.parse(storage.map.get(KNOWN_DEVICES_KEY)!)).toEqual([
      ["mid-b", "B", "win32"],
      ["mid-a", "A renamed", "darwin"],
      ["mid-c", "C"],
      ["mid-p", "", "linux"],
    ]);
  });

  it("没有任何可写入的设备项时不触碰存储", () => {
    const storage = memoryStorage(JSON.stringify([["mid-a", "A"]]));
    const known = readKnownDevices(storage);
    let writes = 0;
    rememberKnownDevices({ ...storage, setItem: () => void writes++ }, known, [
      { deviceMid: "mid-a", name: "A", onlineConnections: [] },
      onlineGroup("mid-x"),
    ]);
    expect(writes).toBe(0);
  });

  it(`超过 ${KNOWN_DEVICES_LIMIT} 条时淘汰最久未更新的条目`, () => {
    const seeded = Array.from({ length: KNOWN_DEVICES_LIMIT }, (_, i) => [`mid-${i}`, `D${i}`]);
    const storage = memoryStorage(JSON.stringify(seeded));
    const known = readKnownDevices(storage);
    rememberKnownDevices(storage, known, [
      onlineGroup("mid-0", "D0"),
      onlineGroup("mid-new", "New"),
    ]);
    const stored = JSON.parse(storage.map.get(KNOWN_DEVICES_KEY)!) as [string, string][];
    expect(stored).toHaveLength(KNOWN_DEVICES_LIMIT);
    expect(stored[0]).toEqual(["mid-2", "D2"]);
    expect(stored.at(-2)).toEqual(["mid-0", "D0"]);
    expect(stored.at(-1)).toEqual(["mid-new", "New"]);
  });

  it("写入失败静默忽略，内存中的映射仍已更新", () => {
    const known = new Map();
    expect(() =>
      rememberKnownDevices(
        {
          getItem: () => null,
          setItem() {
            throw new Error("blocked");
          },
        },
        known,
        [onlineGroup("mid-a", "A", "darwin")],
      ),
    ).not.toThrow();
    expect([...known]).toEqual([["mid-a", { name: "A", platform: "darwin" }]]);
  });
});
