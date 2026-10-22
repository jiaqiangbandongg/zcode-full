# Project workflow

完成卡与 run 侧板使用同一个保存控制器，workflowRunSavedStore 是已保存工作流投影的唯一缓存。Agent 保存 run 的脚本，Host projectService 裁决目标项目与 cwd；调用方不能通过相同路径推断设备或归属。

保存成功才发布缓存结果，失败保留原状态。再次运行复用 saved-workflow launcher，默认目标从原会话解析，显式选项目则使用选择结果；不改写既有会话 cwd。查询与失效继续使用既有 generation/key，侧板提炼请求发给父会话。

模块只调整源码边界，保持只读/灰度门、窄屏、主题及文案不变。桌面/手机继续使用宿主既有命令和 continuous/replayable 边界。
