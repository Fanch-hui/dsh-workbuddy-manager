# 安装、配置与排障

本文件是仓库内的完整使用说明，不随插件包分发。

## 环境

- DSH `0.2.2-rc.1`；插件的 `engines.dsh` 为 `>=0.2.2-rc.1 <0.3.0`。DSH 宿主要求 Node ≥24.9。
- 已部署并启动 [WorkBuddy Manager](https://github.com/ithtelab/workbuddy-manager) `2.11.10`；账号池直连使用本项目提供的桥接镜像，默认管理地址为 `http://127.0.0.1:7864`。
- WorkBuddy Manager 管理员账号；可在插件内扫码或通过登录链接添加账号。

## 桌面版安装

1. 按下方说明构建并启用 WorkBuddy Manager 桥接镜像。
2. 从仓库执行 `npm pack`，在 DSH 插件页面安装生成的 `dsh-workbuddy-manager-0.4.1.tgz` 并启用，然后完全退出并重启 DSH。
3. 打开 **设置 → WorkBuddy**。本机填写 `http://127.0.0.1:7864`；远程服务使用 HTTPS。
4. 使用管理用户名和密码登录。插件自动连接账号池并同步模型；需要添加账号时，在账号管理中获取登录链接，扫码、复制链接或打开链接完成授权。
5. 在对话模型选择器选择 **WorkBuddy 账号池**下的模型。已有网关密钥仍可在设置中选择或输入。

从 `0.1.0` 升级时，如果路由仅来自旧版 bundle，插件会识别已保存的默认凭据；点击**保存并同步模型**即可恢复连接。已有 WorkBuddy 提供方会读取并保留其模型和高级设置；有多个候选时先选择目标。其他提供方无需迁移。

## 账号池桥接部署

在项目目录构建基于官方 `2.11.10` 镜像的桥接镜像：

```sh
docker build -t dsh-workbuddy-bridge:2.11.10 -f bridge/Dockerfile bridge
```

对于 Compose 部署，确认原项目名称、Compose 文件和管理服务名后，将它们分别填入 `PROJECT`、`COMPOSE_FILE`；提供的叠加文件针对服务名 `manager`：

```sh
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" -f bridge/compose.yaml up -d --no-deps --no-build manager
```

该操作只重建管理服务，原账号池容器、配置和数据卷继续使用。服务名不同时，先修改叠加文件中的服务名。恢复官方镜像时使用相同项目名和原 Compose 文件，执行 `docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --no-deps --no-build manager`。

桥接镜像固定适配 `2.11.10`；升级上游时需要重新核对并测试补丁。桥接模型调用使用默认上游，走管理员会话授权，按服务安全设置执行全局 IP 规则和限流；网关密钥的额度、模型及上游分组限制不作用于这条连接。请求会消耗账号积分并记录请求日志。

## 模型与凭据

插件复用 DSH 自带的 `llm-pi-ai` 和 `openai-responses` 协议，为账号池桥接创建独立提供方，保留其他提供方和旧网关连接。模型同步只追加新发现的模型，不覆盖或删除已有模型。

管理登录会话和仅限模型调用的桥接会话按地址保存在 DSH 凭据服务中，模型配置只记录凭据引用，不保存管理密码。模型请求期间插件会续用桥接会话；退出管理时清除本机保存的会话。管理账号降权、删除或会话吊销后，桥接会话也会失效。

旧网关密钥连接仍按原方式工作：留空时复用已有 `apiKeyEnv`；输入或选择密钥时使用插件专属凭据引用，避免覆盖其他提供方共享的凭据。

插件管理已部署的网关连接；容器或进程仍由 Docker Desktop、Compose 或部署环境的服务管理器启停。

## 命令行安装与查询

```sh
npm pack
dsh plugin --profile demo add ./dsh-workbuddy-manager-0.4.1.tgz
# 发布后：dsh plugin --profile demo add dsh-workbuddy-manager
```

只读 CLI 支持 `doctor`、`status`、`models`、`usage`、`me`、`accounts`、`credits`。使用 `WORKBUDDY_MANAGER_URL` 指定地址，`WORKBUDDY_MANAGER_API_KEY` 指定网关密钥；管理面只读查询使用 `WORKBUDDY_MANAGER_READONLY_TOKEN`。可选 `--url`、`--timeout` 和 `--json` 参数。CLI 原样输出服务响应，不假定响应字段；错误信息会脱敏。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装时 DSH 版本不兼容 | 使用 `0.2.2-rc.1`，核对插件的 `engines.dsh`。 |
| `npm pack` 报 `EPERM`（npm 缓存含 root 文件） | 临时用 `npm_config_cache="$(mktemp -d)" npm pack`；长期按报错中的目录执行 `sudo chown -R "$(id -u):$(id -g)" <缓存目录>`。 |
| `ERR_PNPM_UNEXPECTED_STORE` | 将该 profile 的 `pnpm-workspace.yaml` 的 `storeDir` 设为报错中原 store 的父目录，保留现有配置，再重试。pnpm 11 会自行追加 `v11`。 |
| 设置中没有 WorkBuddy | 确认插件已安装并启用，重启 DSH 后再打开设置。 |
| 提示账号池服务尚未启用 DSH 桥接 | 构建并启用桥接镜像，确认地址指向该服务。 |
| 桥接连接失败或 HTTP 401 | 检查服务地址并重新登录管理员账号；旧网关连接还需检查密钥及模型权限。 |
| 没有发现模型 | 检查默认账号池是否有可用账号，以及对应国内版／国际版模型。 |
| 配置发生冲突 | 点击 **重新载入**，检查当前设置后重新同步。 |
| 模型配置更新但密钥保存失败 | 检查 DSH 凭据存储是否可写，重新载入页面后重试。 |

## 安全和使用边界

- 不把网关密钥写入模型配置、命令历史或项目文件。远程网关使用 HTTPS。
- CLI 管理面查询建议使用只读令牌，不使用管理员会话 Cookie。
- 仅管理本人及亲属自愿授权的账号，遵循上游项目的授权和使用规则；禁止批量注册、账号交易、绕过平台风控和商业转售。

## 开发与验证

```sh
npm install
npm run typecheck
npm test
npm run test:desktop
npm run check:package
npm pack --dry-run
```

macOS 桌面宿主集成测试使用目标桌面版运行时和临时本地模拟网关，覆盖模型发现、字段级配置更新、流式请求、工具调用与管理会话恢复。非默认安装位置可用 `DSH_ELECTRON_BIN` 指定 Electron 可执行文件、`DSH_RUNTIME_ROOT` 指定 asar 内的 `dsh` 目录。

普通 `npm test` 不启动桌面宿主；升级 DSH 后应运行 `npm run test:desktop` 重新核对设置、凭据、模型发现和 `llm-pi-ai` schema 接口，并重跑测试。
