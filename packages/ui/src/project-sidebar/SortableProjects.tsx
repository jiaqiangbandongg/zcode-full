import type { ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { projectKey } from "@/project-sidebar/view.js";

// Bug 根因：内联 options 会让 useSensor 每次目录更新都重建 activators/listeners，
// 通过拖拽 Context 穿透项目 memo。配置不随任务活动变化，保留同一对象即可。
const pointerOptions = { activationConstraint: { distance: 6 } };
const keyboardOptions = { coordinateGetter: sortableKeyboardCoordinates };

/** 原因：原生 HTML 拖放只在 drop 后换顺序，缺少旧项目树的相邻行位移动画。 */
export function SortableProjects({
  projects,
  renderProject,
  onReorder,
}: {
  projects: VirtualProject[];
  renderProject(project: VirtualProject): ReactNode;
  onReorder(active: string, over: string): void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, pointerOptions),
    useSensor(KeyboardSensor, keyboardOptions),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
      }}
    >
      <SortableContext items={projects.map(projectKey)} strategy={verticalListSortingStrategy}>
        {projects.map(renderProject)}
      </SortableContext>
    </DndContext>
  );
}
