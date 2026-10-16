import type { OutputStyle, OutputStyleConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IOutputStyleService {
  /**
   * 加载所有可用的 output styles
   */
  listStyles(): Promise<{ styles: OutputStyle[] }>;

  /**
   * 添加新的 output style
   */
  addStyle(params: { config: OutputStyleConfig }): Promise<void>;

  /**
   * 更新现有的 output style
   */
  updateStyle(params: { id: string; config: OutputStyleConfig }): Promise<void>;

  /**
   * 删除 output style
   */
  deleteStyle(params: { id: string }): Promise<void>;

  /**
   * 获取用户 output styles 目录路径
   */
  getUserStylesDirectory(): Promise<{ path: string }>;

  /**
   * 设置当前激活的 output style
   */
  setActiveStyle(params: { styleId: string }): Promise<void>;

  /**
   * 获取当前激活的 output style
   */
  getActiveStyle(): Promise<{ styleId: string | null }>;
}

export const IOutputStyleService = createServiceDescriptor<IOutputStyleService>(
  ServiceChannels.OutputStyle,
);
