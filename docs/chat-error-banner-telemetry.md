# Chat Error Banner Telemetry（V4 待迁移）

`chatErrorBannerTelemetry.ts` 目前只有 helper/测试，没有 V4 生产调用点；error banner 曝光、CTA 点击和 dismiss 不能视为已上报。

重接时应以 V4 error fingerprint 和 pane lifecycle 去重，禁止随 render 次数重复上报，并在 desktop/mobile 两种 delivery profile 下验证。完成生产接线前，监控看板必须把该数据标成缺失。
