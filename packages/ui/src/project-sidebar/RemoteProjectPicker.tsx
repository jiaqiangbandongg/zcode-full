import type { ComponentProps } from "react";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { RemoteProjectList } from "@/project-sidebar/RemoteProjectList.js";

/** 旧连接/项目入口继续保留新建能力；创建表单只复用列表，避免两个草稿 owner。 */
export function RemoteProjectPicker(
  props: Omit<ComponentProps<typeof RemoteProjectList>, "renderCreate">,
) {
  return (
    <RemoteProjectList
      {...props}
      renderCreate={(projects, add, close) => (
        <ProjectEditor
          host={props.host}
          initialRoots={props.initialRoots}
          project={null}
          projects={projects}
          service={props.service}
          onClose={close}
          onSaved={add}
        />
      )}
    />
  );
}
