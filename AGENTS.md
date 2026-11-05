# dsh-workbuddy-manager

## 项目目标
- 把 [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) 的账号池网关接入 DeepSeek Harness（DSH），让 DSH 模型选择器直接使用网关提供的模型；附带只读运维 CLI。插件连接用户已部署的 Python/FastAPI 服务，不内嵌、不改写上游源码。

## 版本基线（升级时先核对）
- 开发基线 DSH `0.2.2-rc.1`（2026-11-04 发布，`next` 标签；`latest` 仍滞后于 `0.2.1-rc.5`），Cordis `4.1.0`、pi-ai `1.3.0`，DSH 宿主要求 Node ≥24.9。
- `engines.dsh` 声明 `>=0.2.2-rc.1 <0.3.0`；插件自身 CLI 兼容 Node ≥22。
- 升级 DSH 时按官方 Release Notes 核对插件 API 破坏性变更（0.2.2-rc.1 涉及 `agent.model`、tools 配置 overlay、Session Projection 异步化等），并重新验证 `llm-pi-ai` 的 provider schema 字段。

## 架构约定
- **配置层插件（bundle）**：`cordis.patch.yml` 按 id 覆盖 `dsh-base` 里零路由休眠挂载的 `llm-pi-ai` 行，注入 `workbuddy-manager` 手工声明路由。协议用 `openai-responses`（上游文档明确 DSH 自定义提供方应选此协议，且需单独建一个提供方）。
- **不自写 LlmAdapter**：官方 `dsh-llm-pi-ai` 已负责协议转换、流式分片、重试与模型发现；自写适配器只会重复实现并跟随破坏性变更。
- **整行替换**：bundle patch 会替换 `llm-pi-ai` 行的整份 `config`（不深合并）。用户若还有其它自定义 provider，须在 profile 自己的 `cordis.patch.yml` 里重写该行；此限制写入 `docs/usage.md`。
- **凭据**：网关密钥用 `apiKeyEnv: WORKBUDDY_MANAGER_API_KEY`，经 DSH credential seam 按请求解析；密钥绝不写入配置文件、代码、日志或测试夹具。CLI 读同名环境变量，与宿主共享同一来源。
- **唯一连接配置来源**：`cordis.patch.yml` 决定 DSH 侧路由（baseURL、协议、模型目录）；CLI 只从环境变量/命令行参数读连接信息，不复制一份静态配置。
- **只读边界**：CLI 只做 `/healthz`、`/v1/models`、`/v1/usage`、`/api/me`、`/api/accounts`、`/api/accounts/credits-snapshot` 的只读查询，不提供扫码纳管、签到、账号增删、密钥管理等写操作；遵守上游免责声明（仅限本人及亲属自愿授权账号，禁止批量注册、账号交易、绕过风控与商业转售）。
- **不编造上游字段**：workbuddy-manager 未在文档中给出 `/v1/models`、`/v1/usage` 等响应的具体 JSON 字段，CLI 默认输出原始 JSON，不做字段名假设。

## 结构与命令
- `cordis.patch.yml`：bundle 配置层；`src/`：CLI 与只读 HTTP 客户端；`scripts/check-package.mjs`：打包前校验 patch 与产物；`tests/`：真实本地 HTTP 服务的契约测试；`docs/usage.md`：不随包分发的完整安装与排障说明。
- `README.md` 会作为 DSH 插件详情页全文展示，只写简介与上手步骤。
- `npm run typecheck`、`npm test`、`npm run build`、`npm run check:package`、`npm pack --dry-run`。
- 提交源码前完成最小必要的类型检查、测试、构建与 diff review；项目记忆不纳入代码提交。
