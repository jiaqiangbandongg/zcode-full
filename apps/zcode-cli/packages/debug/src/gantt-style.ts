export const GANTT_BAR_MIN_WIDTH_PX = 18;

type GanttItemType = "range" | "point";

export function ganttItemStyle(type: GanttItemType): string | undefined {
  if (type !== "range") return undefined;
  return `min-width: ${GANTT_BAR_MIN_WIDTH_PX}px;`;
}
