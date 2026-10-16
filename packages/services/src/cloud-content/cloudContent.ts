import { ServiceChannels, type CloudContentBundle, type MarketingAsset } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface ICloudContentService {
  readPublishedMedia(input: { asset: MarketingAsset; kind: "image" | "video" }): Promise<string>;
  prepare(input: {
    bundle: CloudContentBundle;
  }): Promise<{ leaseId: string; url: string; cacheHit: boolean }>;
  release(input: { leaseId: string }): Promise<void>;
}
export const ICloudContentService = createServiceDescriptor<ICloudContentService>(
  ServiceChannels.CloudContent,
);
