# Workspace plugin preview

负责工作区入口的插件缩略图和选择列表；通过既有 catalog hook 获取数据，不持有另一份插件安装状态。

仅启用且无冲突的插件可引用。选择输出 canonical plugin mention；浏览市场沿用既有导航事件。workspace/session 隔离、排序和加载状态保持原有逻辑。

缩略图和列表复用 PluginIcon 的图片尺寸规则，不覆盖 img 大小；缺失图片的占位图标仍为 16px。共享图片按原比例完整展示，圆角由容器裁切。
