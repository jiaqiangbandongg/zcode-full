import type { ModelMessageContentBlock } from "../deps.js";
import { containsOfficialCuaImageRefCredentialText } from "@zcode/zcode-cua/frame-contract";

export const OFFICIAL_CUA_RASTER_UNAVAILABLE_TEXT =
  "This CUA raster is not visible in this request. " +
  "Do not send a coordinate target; capture a new raster first.";

export function officialCuaImageRefIndexesForUnavailableMedia(
  content: readonly ModelMessageContentBlock[],
  unavailableMediaIndexes: ReadonlySet<number>,
): Set<number> {
  const imageRefIndexes = new Set<number>();
  for (const mediaIndex of unavailableMediaIndexes) {
    if (content[mediaIndex]?.type !== "image") continue;
    const candidate = content[mediaIndex + 1];
    if (
      candidate?.type === "text" &&
      containsOfficialCuaImageRefCredentialText(candidate.text)
    ) {
      imageRefIndexes.add(mediaIndex + 1);
    }
  }
  return imageRefIndexes;
}

export function officialCuaRasterUnavailableBlock(): ModelMessageContentBlock {
  return { type: "text", text: OFFICIAL_CUA_RASTER_UNAVAILABLE_TEXT };
}
