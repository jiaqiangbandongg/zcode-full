import type { WebRemoteControlDeviceGroup, KnownDevice } from "#src/web-remote-control/contract.js";

// 键名沿用旧版“设备名”缓存，旧的 [mid, name] 条目可直接读出。
export const KNOWN_DEVICES_KEY = "zcode-web-remote-device-names";
/** 记录只是展示偏好，设上限防止 localStorage 无限增长；超出时淘汰最久未更新的条目。 */
export const KNOWN_DEVICES_LIMIT = 50;

type KnownDeviceStorage = Pick<Storage, "getItem" | "setItem">;

function toKnownDevice(name: string, platform: string | undefined): KnownDevice | null {
  const trimmedName = name.trim();
  const trimmedPlatform = platform?.trim();
  if (!trimmedName && !trimmedPlatform) return null;
  return {
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(trimmedPlatform ? { platform: trimmedPlatform } : {}),
  };
}

/**
 * 读取本机记住的 MID → 设备名/平台。
 * relay 只在设备在线时通过 auth_init.meta 携带主机名和平台，离线记录的 meta 为空，
 * 这份缓存是离线设备名与平台的唯一来源；读取失败或内容损坏都按“没记住任何设备”处理。
 */
export function readKnownDevices(storage: KnownDeviceStorage): Map<string, KnownDevice> {
  const devices = new Map<string, KnownDevice>();
  try {
    const raw = storage.getItem(KNOWN_DEVICES_KEY);
    if (!raw) return devices;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return devices;
    for (const item of parsed) {
      // 旧版只写 [mid, name]；新版在有平台时写 [mid, name, platform]。
      if (!Array.isArray(item) || (item.length !== 2 && item.length !== 3)) continue;
      const [mid, name, platform] = item as unknown[];
      if (typeof mid !== "string" || !mid || typeof name !== "string") continue;
      if (platform !== undefined && typeof platform !== "string") continue;
      const device = toKnownDevice(name, platform);
      if (device) devices.set(mid, device);
    }
  } catch {
    // iOS 私密模式等环境可能禁用存储，或旧内容不是合法 JSON；不阻断列表展示。
    devices.clear();
  }
  return devices;
}

/**
 * 把本次刷新中有在线连接、且有名字或平台的设备项写回缓存。
 * Map 的插入顺序即“最近更新”顺序：先删再设把设备移到末尾，淘汰时从头部开始。
 * 写入失败静默忽略，调用方已经拿到本次投影，不受影响。
 */
export function rememberKnownDevices(
  storage: KnownDeviceStorage,
  known: Map<string, KnownDevice>,
  groups: readonly WebRemoteControlDeviceGroup[],
): void {
  let touched = false;
  for (const group of groups) {
    if (group.onlineConnections.length === 0) continue;
    const device = toKnownDevice(group.name ?? "", group.platform);
    if (!device) continue;
    known.delete(group.deviceMid);
    known.set(group.deviceMid, device);
    touched = true;
  }
  if (!touched) return;
  while (known.size > KNOWN_DEVICES_LIMIT) {
    const oldest = known.keys().next().value;
    if (oldest === undefined) break;
    known.delete(oldest);
  }
  try {
    storage.setItem(
      KNOWN_DEVICES_KEY,
      JSON.stringify(
        [...known].map(([mid, device]) =>
          device.platform ? [mid, device.name ?? "", device.platform] : [mid, device.name ?? ""],
        ),
      ),
    );
  } catch {
    // 偏好持久化失败不影响本次展示，也不修改按 SID 隔离的业务状态。
  }
}
