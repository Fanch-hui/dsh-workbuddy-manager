# 安装、配置与排障

本文件是仓库内的完整使用说明，不随插件包分发。

## 环境

- DSH `0.2.2-rc.1`；插件的 `engines.dsh` 为 `>=0.2.2-rc.1 <0.3.0`。DSH 宿主要求 Node ≥24.9。
- 已部署并启动 [WorkBuddy Manager](https://github.com/ithtelab/workbuddy-manager)，默认管理地址为 `http://127.0.0.1:7864`。
- 已在管理页面创建网关密钥，并给该密钥配置所需的模型权限。

## 桌面版安装

1. 从仓库执行 `npm pack`，生成 `dsh-workbuddy-manager-0.2.0.tgz`；发布后也可直接安装对应包名。
2. 在 DSH 侧栏的插件页面添加安装包，确认插件已启用，然后刷新页面。
3. 打开 **设置 → WorkBuddy**。本机网关可填写 `http://127.0.0.1:7864`，插件自动补全 `/v1`；远程网关使用 HTTPS。
4. 填写在管理页面创建的网关密钥，点击 **保存并同步模型**。插件会先查询可用模型，再写入 DSH 配置和凭据服务。
5. 在对话模型选择器选择 WorkBuddy Manager 的模型。插件页面会检查连接状态；账号、密钥和配额由 **打开管理页面** 进入原管理界面操作。

从 `0.1.0` 升级时，如果之前的 WorkBuddy 路由仅来自旧版 bundle，请在新版页面重新同步模型；如果 DSH 模型设置中已有 `workbuddy-manager` 提供方，新版会读取并保留其配置与凭据引用。其他提供方无需迁移。

## 模型与凭据

插件复用 DSH 自带的 `llm-pi-ai` 和 `openai-responses` 协议，通过设置服务的字段级操作更新 `workbuddy-manager`。已有提供方的 headers、兼容选项、模型设置和已有密钥引用会保留；其他提供方不会被替换。模型同步只追加新发现的模型，不覆盖或删除已有模型；需要手动调整模型详情时，使用 DSH 原有模型设置。

网关密钥经 DSH 凭据服务保存，配置只记录引用名。已存在的 `apiKeyEnv` 会继续使用；新提供方默认使用 `WORKBUDDY_MANAGER_API_KEY`。界面不会读取并显示已保存的密钥；修改时输入新密钥即可，留空表示保留已配置的密钥。首次创建提供方需要输入密钥，以便先检查网关连接。

插件管理已部署的网关连接；容器或进程仍由 Docker Desktop、Compose 或部署环境的服务管理器启停。

## 命令行安装与查询

```sh
npm pack
dsh plugin --profile demo add ./dsh-workbuddy-manager-0.2.0.tgz
# 发布后：dsh plugin --profile demo add dsh-workbuddy-manager
```

只读 CLI 支持 `doctor`、`status`、`models`、`usage`、`me`、`accounts`、`credits`。使用 `WORKBUDDY_MANAGER_URL` 指定地址，`WORKBUDDY_MANAGER_API_KEY` 指定网关密钥；管理面只读查询使用 `WORKBUDDY_MANAGER_READONLY_TOKEN`。可选 `--url`、`--timeout` 和 `--json` 参数。CLI 原样输出服务响应，不假定响应字段；错误信息会脱敏。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装时 DSH 版本不兼容 | 使用 `0.2.2-rc.1`，核对插件的 `engines.dsh`。 |
| `ERR_PNPM_UNEXPECTED_STORE` | 将该 profile 的 `pnpm-workspace.yaml` 的 `storeDir` 设为报错中原 store 的父目录，保留现有配置，再重试。pnpm 11 会自行追加 `v11`。 |
| 设置中没有 WorkBuddy | 确认插件已安装并启用，刷新页面；必要时重启 DSH。 |
| 网关连接失败或 HTTP 401 | 检查服务是否启动、地址是否正确，以及密钥是否有效并允许相应模型。 |
| 没有发现模型 | 检查管理页面中的模型白名单和国内版／国际版权限。 |
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
npm run check:package
npm pack --dry-run
```

macOS 桌面宿主集成测试使用目标桌面版运行时和临时本地模拟网关，覆盖模型发现、字段级配置更新、流式请求与工具调用：

```sh
ELECTRON_RUN_AS_NODE=1 \
DSH_RUNTIME_ROOT="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh" \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --test tests/desktop-host.test.mjs
```

普通 `npm test` 在没有 `DSH_RUNTIME_ROOT` 时跳过桌面宿主集成测试。升级 DSH 后应重新核对设置、凭据、模型发现和 `llm-pi-ai` schema 接口，并重跑测试。
