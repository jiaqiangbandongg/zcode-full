import type { EmbeddedBrowserPermissionDeviceOption } from "@zcode/shared";

/** select-* 事件携带的 Electron 设备对象（HID/USB/Serial/Bluetooth 字段各异）映射为统一弹窗选项。 */
export function readDeviceOptions(rawList: unknown): EmbeddedBrowserPermissionDeviceOption[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.flatMap((device) => {
    const candidate = device as {
      deviceId?: string;
      portId?: string;
      name?: string;
      productName?: string;
      deviceName?: string;
      portName?: string;
      vendorId?: number;
      productId?: number;
      serialNumber?: string;
    };
    const deviceId = candidate.deviceId ?? candidate.portId;
    if (!deviceId) return [];
    return [
      {
        deviceId,
        name: candidate.name ?? candidate.productName ?? candidate.deviceName ?? candidate.portName,
        ...(candidate.vendorId !== undefined ? { vendorId: candidate.vendorId } : {}),
        ...(candidate.productId !== undefined ? { productId: candidate.productId } : {}),
        ...(candidate.serialNumber !== undefined ? { serialNumber: candidate.serialNumber } : {}),
      },
    ];
  });
}
