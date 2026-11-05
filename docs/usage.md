# 安装、配置与排障

本文件是仓库内的完整使用说明，不随插件包分发。

## 环境

- DSH `0.2.2-rc.1`；插件的 `engines.dsh` 为 `>=0.2.2-rc.1 <0.3.0`。DSH 宿主要求 Node ≥24.9。
- 支持 WorkBuddy 国内版（`https://copilot.tencent.com`）与国际版（`https://www.workbuddy.ai`）账号扫码或浏览器链接授权。

## 桌面版安装与使用

1. 从仓库执行 `npm pack`，在 DSH 插件页面安装生成的 `dsh-workbuddy-manager-0.4.2.tgz` 并启用，然后完全退出并重启 DSH。
2. 打开 **设置 → WorkBuddy**。
3. 在 **添加 WorkBuddy 账号** 中选择版本（国内版或国际版），点击 **获取登录链接或扫码**，通过二维码或浏览器完成授权。
4. 授权完成后，账号令牌加密保存在 DSH 凭据服务中，宿主自动在 `127.0.0.1:随机端口` 启动本地网关并同步模型。
5. 在对话模型选择器选择 **WorkBuddy 账号池** 下的模型即可开始对话。

## 架构说明

- **管理链路**：`设置页 → workbuddy/manage（仅所有者可调用）→ 账号池服务 → DSH 凭据服务`
- **模型调用链路**：`llm-pi-ai → 127.0.0.1:随机端口（临时密钥）→ 本地网关 → copilot.tencent.com/v2 或 www.workbuddy.ai/v2`
- **协议与兼容**：
  - 本地网关向 `llm-pi-ai` 暴露标准 `openai-completions` 接口（`/v1/models` 与 `/v1/chat/completions`），并通过 `llm-pi-ai/request-headers` 自动注入 DSH 会话标识与每次启动随机生成的 32 字节临时网关密钥。
  - 向上游请求时模拟 WorkBuddy CLI 的 `X-Stainless-*` 指纹头、确定性会话与消息 ID（`X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Request-ID`）以及 `gzip` 请求体压缩。
  - 工具 Schema 自动归一化并在流式响应中还原工具名称；遇到上游 `11128` 提示词风控拒绝时自动依次尝试句首逗号停顿改写与系统提示词下沉（`<instructions>`），遇到 `11153` 工具尾消息限制时自动补齐助手消息。
  - 多账号轮询负载均衡：单个账号令牌过期时自动单飞刷新，遇到限流（`429`）或额度耗尽（`14018`）时进入冷却窗口并自动切换到池内其他可用账号。

## 命令行安装与查询

```sh
npm pack
dsh plugin --profile demo add ./dsh-workbuddy-manager-0.4.2.tgz
# 发布后：dsh plugin --profile demo add dsh-workbuddy-manager
```

只读 CLI 支持 `doctor`、`status`、`models`、`usage`、`me`、`accounts`、`credits`。使用 `WORKBUDDY_MANAGER_URL` 指定地址，`WORKBUDDY_MANAGER_API_KEY` 指定网关密钥；管理面只读查询使用 `WORKBUDDY_MANAGER_READONLY_TOKEN`。可选 `--url`、`--timeout` 和 `--json` 参数。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装时 DSH 版本不兼容 | 使用 `0.2.2-rc.1`，核对插件的 `engines.dsh`。 |
| `npm pack` 报 `EPERM`（npm 缓存含 root 文件） | 临时用 `npm_config_cache="$(mktemp -d)" npm pack`；长期按报错中的目录执行 `sudo chown -R "$(id -u):$(id -g)" <缓存目录>`。 |
| 设置中没有 WorkBuddy | 确认插件已安装并启用，完全退出并重启 DSH 后再打开设置。 |
| 账号显示「授权过期」 | 点击重新扫码或获取登录链接重新授权该账号。 |
| 账号显示「冷却中」或「异常受限」 | 账号触发上游速率限制、额度耗尽或风控限制；可添加多个账号分担请求或点击「刷新状态与积分」。 |
| 配置发生冲突 | 点击 **重新载入**，检查当前设置后重新同步。 |

## 安全和使用边界

- 账号令牌与临时网关密钥仅保存在 DSH 凭据服务中，不写入模型配置文件、命令历史或日志。
- 仅管理本人及亲属自愿授权的账号；禁止批量注册、账号交易、绕过平台风控和商业转售。

## 开发与验证

```sh
npm install
npm run typecheck
npm test
npm run test:desktop
npm run check:package
npm pack --dry-run
```
