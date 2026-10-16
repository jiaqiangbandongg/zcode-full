# Bootstrap 命令

`pnpm bootstrap` 是默认本地初始化入口。它会先拉取 `apps/zcode-cli` submodule，再安装依赖、准备 desktop 本地 runtime 资源，并执行 bootstrap 构建；默认不准备 remote `mock-cdn` 资源。

`pnpm bootstrap:with-remote` 保留远程调试需要的完整初始化流程。它会先拉取 `apps/zcode-cli` submodule，再安装依赖、准备 desktop 本地 runtime 资源、准备 remote `mock-cdn` 资源，并执行 bootstrap 构建。

如只需要单独准备 remote 资源，可以执行 `pnpm prepare:remote-assets`。

