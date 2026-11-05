# 安装、配置与排障

本文件不随插件包分发，是仓库内的完整说明。

## 1. 版本基线

| 项 | 值 |
| --- | --- |
| DSH | `0.2.2-rc.1`（2026-11-04 发布，`next` 标签） |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0` |
| Cordis / pi-ai | `4.1.0` / `1.3.0` |
| DSH 宿主 Node | ≥24.9（插件 CLI 自身兼容 ≥22） |

DSH 目前**没有 stable 版**：`npm latest` 仍指向 `0.2.1-rc.5`，`next` 才是 `0.2.2-rc.1`。启动请用 `npx @deepseek-ai/dsh@0.2.2-rc.1` 或 `@next`，否则 `engines.dsh` 会在安装/启动时拒绝本 bundle。

`0.2.2-rc.1` 的破坏性变更集中在 `agent.model`、tools 配置 overlay、Session Projection 异步化等；本插件是**配置层 bundle**，不注册适配器、不调用这些 API，因此不受影响。升级 DSH 时仍应复核 `@deepseek-ai/dsh-llm-pi-ai` 的 provider schema 是否有字段变化。

## 2. 前置条件

- 已按 [上游部署指南](https://github.com/ithtelab/workbuddy-manager/blob/main/deploy/README.md) 部署 WorkBuddy Manager，默认 `http://127.0.0.1:7864`。公网访问请走 HTTPS 反向代理，不要直接暴露管理面。
- 在面板「密钥」页创建一把网关密钥 `wbk_...`，并确认它的**模型白名单 / 版本（国内版或国际版）/ Token 与积分配额**符合你的使用需求。
- 可选：在「设置 → API 令牌」创建 `scope=readonly` 的只读令牌 `wbt_...`，供 CLI 查询管理面。

插件不负责纳管账号、签到或分发密钥，这些仍在原面板完成。

## 3. 安装

```sh
# 本地打包（推荐，产物已构建，安装时无需执行脚本）
npm pack
dsh plugin --profile demo add ./dsh-workbuddy-manager-0.1.0.tgz

# 或发布到 npm 后
dsh plugin --profile demo add dsh-workbuddy-manager

# 验证配置层已生效（应看到本 bundle 的层与 workbuddy-manager 路由）
dsh --profile demo --dump-config

# 卸载
dsh plugin --profile demo remove dsh-workbuddy-manager
```

从 GitHub 安装也可以，但 git 依赖拉的是源码：pnpm ≥10 默认不执行 `prepare`，需在 profile 的 `pnpm-workspace.yaml` 里显式允许，并固定 commit：

```yaml
allowBuilds:
  dsh-workbuddy-manager: true
```

```sh
dsh plugin --profile demo add github:you/dsh-workbuddy-manager#<sha>
```

允许构建等于允许该包在安装时执行代码，只对你信任的仓库开启。

## 4. 配置密钥

`cordis.patch.yml` 只声明 `apiKeyEnv: WORKBUDDY_MANAGER_API_KEY`，密钥由 DSH credential seam 按请求解析。写入托管凭据文件（`$DSH_HOME/.credentials.yaml`，或 `~/.dsh/.credentials.yaml`）：

```yaml
version: 1
refs:
  WORKBUDDY_MANAGER_API_KEY: wbk_xxxxxxxx
```

解析优先级：**托管凭据文件 > 启动 DSH 时的环境变量 > 项目 `.env` > `$DSH_HOME/.env`**。环境变量需在启动 DSH 时就存在（launcher 拍的是启动环境快照，启动后再 `export` 不会被看到）：

```sh
WORKBUDDY_MANAGER_API_KEY=wbk_xxxxxxxx dsh --profile demo
```

密钥永不写入 `cordis.patch.yml`、日志或本仓库；`scripts/check-package.mjs` 会在打包前检查配置里是否混入 `wbk_` / `wbt_` 明文。

## 5. 修改连接配置

`cordis.patch.yml` 是 DSH 侧连接配置的唯一来源。改完重新 `--dump-config` 并在下一次请求生效（`llm-pi-ai` 按请求解析 profile，无需重启）。

**改地址**：把 `baseURL` 换成你的服务地址，保留 `/v1` 结尾（`llm-pi-ai` 的模型发现会请求 `{baseURL}/models`，即 `/v1/models`）：

```yaml
baseURL: https://wb.example.com/v1
```

**加模型**：在 `models` 下追加条目。上游常见模型（上下文均为 131072）：`glm-5.2`、`glm-5.1`、`glm-5v-turbo`、`kimi-k2.7`、`minimax-m3`、`hy3`、`hy3-preview`。以面板「设置 → 可用模型」实时拉取结果为准。国际版模型带 `global:` 前缀，且要求密钥版本为国际版，跨版本会被拒绝：

```yaml
- id: global:glm-5.2
  name: GLM-5.2 (Global)
  contextWindow: 131072
```

若网关提供视觉模型，可给条目加 `input: [text, image]`；默认按 `[text]` 处理，避免把图片发给不支持的端点。

**协议**：默认 `openai-responses`。上游文档明确「只发 `openai-responses` 协议的客户端（如 DeepSeek Harness 的自定义提供方）……需要单独建一个提供方」，因此不要用 `openai-completions` 的提供方复用它。若确实要改用 chat/completions，把 `api` 改为 `openai-completions`，并**删除** `compat.supportsMaxOutputTokens`（该字段只对 Responses 协议有效），必要时加 `compat.maxTokensField: max_tokens`；注意上游未文档化 chat/completions 侧的 tool calling 支持情况。

**兼容开关**：`compat.supportsMaxOutputTokens: false` 让 `llm-pi-ai` 省略 `max_output_tokens`，因为上游未声明接受该字段。若你的网关确认支持，可改为 `true`。

**其它**：`defaultContextWindow` / `defaultMaxTokens` 是未描述模型的容量回退；`retryPolicy` 控制 provider 自有重试（默认 normal、5 次，本插件设为 2 次，避免账号池被重复扣费）。

### 与其它自定义 provider 共存

bundle patch 会**整行替换** `llm-pi-ai` 行的 `config`，不做深合并。`dsh-base` 里该行原本是零路由休眠挂载，所以默认不会丢任何东西；但如果你在更早的 bundle 或设置页里配过其它 provider，请在 **profile 自己的 `cordis.patch.yml`**（后层优先）重写整行，把所有 provider 一起列出：

```yaml
- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          workbuddy-manager:
            apiKeyEnv: WORKBUDDY_MANAGER_API_KEY
            api: openai-responses
            baseURL: http://127.0.0.1:7864/v1
            models:
              - id: glm-5.2
          my-other-gateway:
            apiKeyEnv: MY_OTHER_KEY
            api: openai-completions
            baseURL: https://other.example/v1
            models:
              - id: some-model
```

## 6. 只读 CLI

```sh
export WORKBUDDY_MANAGER_URL=http://127.0.0.1:7864
export WORKBUDDY_MANAGER_API_KEY=wbk_xxxxxxxx          # /v1 数据面
export WORKBUDDY_MANAGER_READONLY_TOKEN=wbt_xxxxxxxx    # /api 管理面，可选

dsh-workbuddy doctor      # 逐项体检，任一失败返回退出码 1
dsh-workbuddy status      # 聚合 healthz / models / usage，单项失败不影响其它项
dsh-workbuddy models      # 网关可见模型
dsh-workbuddy usage       # 这把密钥的 Token / 积分额度与有效期
dsh-workbuddy me          # 当前登录身份（只读令牌）
dsh-workbuddy accounts    # 账号列表（只读令牌）
dsh-workbuddy credits     # 已登记积分的只读快照

dsh-workbuddy models --json --url https://wb.example.com --timeout 20000
```

`--json` 输出紧凑 JSON，默认输出缩进 JSON。上游未文档化这些端点的响应字段，所以 CLI 原样输出，不做字段名假设；错误响应会经过脱敏，不会回显你提交的密钥。CLI 只发 GET，不做扫码纳管、签到、账号增删或密钥管理。

## 7. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 安装被拒绝 / `engines.dsh` 不满足 | 当前 DSH 是 `0.2.1-rc.5`；改用 `@0.2.2-rc.1` 或 `@next` |
| `MISSING_CREDENTIAL` | `WORKBUDDY_MANAGER_API_KEY` 未配置；检查 `$DSH_HOME/.credentials.yaml` 的 `refs` 分节，或在启动 DSH 时导出 |
| `INVALID_CREDENTIAL` / HTTP 401 | 密钥错误、被停用或版本不匹配；在面板核对密钥与 `/v1/models` 的返回 |
| 模型选择器里没有 WorkBuddy Manager | 先 `dsh --profile demo --dump-config` 确认 bundle 层存在；再确认 profile 层没有覆盖 `llm-pi-ai` 行 |
| `/v1/models` 列表为空 | 密钥的模型白名单/版本限制；国内版与国际版（`global:`）互不通用 |
| HTTP 400 且请求体含 `max_output_tokens` | 保留 `compat.supportsMaxOutputTokens: false` |
| `TRANSPORT` / 连接超时 | 服务未启动、端口不对或反代拦截；用 `dsh-workbuddy doctor` 定位，公网请改用 HTTPS |
| 模型目录与实际不符 | 以面板「设置 → 可用模型」为准，编辑 `cordis.patch.yml` 的 `models`；也可用 `dsh-workbuddy models --json` 对照 |

## 8. 安全与使用边界

- 密钥只在 DSH 凭据/环境变量中，配置层仅引用变量名；CLI 不持久化、不打印密钥，错误响应会脱敏。
- 管理面命令建议使用 `scope=readonly` 的 `wbt_` 令牌，不要用管理员会话 Cookie 或 `scope=admin` 令牌。
- 遵循上游免责声明：**仅用于管理本人及亲属自愿授权的账号**，自用与学习研究；禁止批量注册、代注册、接码、账号买卖出租、盗号撞库、绕过实名/风控/区域限制，以及任何对外收费、转售、引流或盈利性用途。违规导致的封号、数据丢失与法律责任由使用者自行承担。本项目与腾讯、CodeBuddy 官方无隶属关系。

## 9. 开发

```sh
npm install
npm run typecheck     # tsc --noEmit
npm test              # 先构建，再用真实本地 HTTP 服务跑契约测试
npm run build         # 输出 lib/
npm run check:package # 校验 bundle 配置与构建产物
npm pack --dry-run    # 检查最终发布内容
```

升级 DSH 时的检查清单：① `npm view @deepseek-ai/dsh dist-tags --json` 确认新版；② 读官方 Release Notes 的 breaking changes；③ 用 `npm pack @deepseek-ai/dsh-llm-pi-ai@<版本>` 复核 `PiAiProviderProfile` 字段；④ 更新 `engines.dsh` 与 `scripts/check-package.mjs` 的版本断言；⑤ 重跑上面的验证命令。
