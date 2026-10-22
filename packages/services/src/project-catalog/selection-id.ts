/** 选择项只按 Host/项目隔离，不承担 workspace 身份或路径语义。 */
export function projectSelectionId(project: { hostId: string; id: string }): string {
  return JSON.stringify([project.hostId, project.id]);
}
