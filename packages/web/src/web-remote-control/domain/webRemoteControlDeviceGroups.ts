import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type { KnownDevice, WebRemoteControlDeviceGroup } from "#src/web-remote-control/contract.js";

/**
 * MID 只负责设备展示；保留全部在线 SID，连接与业务状态仍按 SID 隔离。
 * knownDevices 是本机记住的 MID → 设备名/平台：离线记录的 meta 为空，只能靠它显示名字和平台图标。
 */
export function groupWebRemoteControlDevices(
  records: WebRemoteControlRelayV2Device[],
  locale: string,
  knownDevices: ReadonlyMap<string, KnownDevice> = new Map(),
): WebRemoteControlDeviceGroup[] {
  const collator = new Intl.Collator(locale);
  // 显示名优先取记录自带的 meta.name，缺失时回退到记住的名字；排序与聚合共用同一口径。
  const displayName = (record: WebRemoteControlRelayV2Device) =>
    record.meta.name?.trim() || knownDevices.get(record.device_mid)?.name || "";
  const displayPlatform = (record: WebRemoteControlRelayV2Device) =>
    record.meta.platform?.trim() || knownDevices.get(record.device_mid)?.platform || "";
  const sorted = records.toSorted((a, b) => {
    const aName = displayName(a);
    const bName = displayName(b);
    return (
      Number(b.online) - Number(a.online) ||
      Number(!aName) - Number(!bName) ||
      collator.compare(aName, bName) ||
      collator.compare(a.device_mid, b.device_mid) ||
      collator.compare(a.device_sid, b.device_sid)
    );
  });
  const groups = new Map<string, WebRemoteControlDeviceGroup>();
  for (const record of sorted) {
    let group = groups.get(record.device_mid);
    if (!group) {
      group = {
        deviceMid: record.device_mid,
        name: displayName(record) || undefined,
        onlineConnections: [],
      };
      groups.set(record.device_mid, group);
    }
    // 在线记录排在前面，平台取第一条能给出平台的记录；缺失字段不写入，保持旧投影形状。
    if (!group.platform) {
      const platform = displayPlatform(record);
      if (platform) group.platform = platform;
    }
    // 历史离线注册不再生成设备行；在线 SID 不能去重成一个随意选择的连接目标。
    if (record.online) group.onlineConnections.push(record);
  }
  return [...groups.values()];
}
