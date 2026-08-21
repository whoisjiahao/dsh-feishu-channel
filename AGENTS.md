# 贡献者约束

- 保留函数插件的命名导出：`name`、`inject`、`Config`、`apply`；不要加默认导出。
- Loader 元数据留在 `src/index.ts`，schema/默认值在 `src/config.ts`，host 边界与激活在 `src/runtime.ts`。
- 所有注册（transport 订阅、事件监听、effect）都挂在插件 fiber 作用域内，并测试卸载路径。
- host 提供的运行时 API 一律保持 peer 依赖与窄契约（`src/host.ts` 的结构拷贝），开发期 import 只解析自本仓库声明的依赖。
- 仓库自包含与可移植：一切路径与引用（源码、文档、配置、`link:` / `file:` 依赖）都相对本仓库根解析，clone 后即可独立构建、测试与发布。
- 行为变化时同步更新 README.md、docs/DESIGN.md（概念归属/代码边界/验证矩阵）、配置 JSDoc、测试与 `cordis.patch.yml`。
- 发布前跑 `pnpm gates`（typecheck + test + build + pack 冒烟 + 版本一致性）。
- 改代码必须 bump `package.json` 的 version：pnpm store 按 tgz 文件名缓存，版本不变会被当成"已装过"而复用旧包。
- `lib/` 提交进 git：改完 `src/` 后跑 `pnpm build` 并提交产物。
- 端到端测试优先挂到 `tests/harness.ts` 的 fake 服务上（经 `apply` 挂载，见 `tests/plugin.spec.ts`）；纯逻辑单元测试只测不依赖宿主的部分。
