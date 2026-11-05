# dsh-workbuddy-manager

把 [WorkBuddy Manager](https://github.com/ithtelab/workbuddy-manager) 的账号池网关接入 **DeepSeek Harness**。安装后，DSH 模型选择器里直接出现网关提供的模型（GLM、Kimi、MiniMax、混元等），无需手写适配器或改上游一行代码；同时附带一个只读运维 CLI。

本插件连接你**已经部署好**的 WorkBuddy Manager 服务，不内嵌、不修改它的 Python 后端与 Web 控制台。管理面板仍按原方式在浏览器打开。

## 适配版本

- 开发基线 **DSH `0.2.2-rc.1`**（2026-11-04，`next` 标签）、Cordis `4.1.0`、pi-ai `1.3.0`；`engines.dsh` 为 `>=0.2.2-rc.1 <0.3.0`。
- DSH 尚无 stable 版，`npm latest` 目前滞后在 `0.2.1-rc.5`，请使用 `npx @deepseek-ai/dsh@0.2.2-rc.1` 或 `@next`；DSH 宿主要求 Node ≥24.9。
- 模型请求走 DSH 官方 `@deepseek-ai/dsh-llm-pi-ai` 适配器，协议选 `openai-responses`（上游文档明确：只发该协议的客户端需要单独建一个提供方）。

## 桌面版接入

先启动 WorkBuddy Manager 并创建网关密钥。在 DSH 桌面版打开**设置 → 模型 → 添加自定义提供方**，填写：

- Provider ID：`workbuddy-manager`；显示名称：`WorkBuddy Manager`
- 基础 URL：`http://127.0.0.1:7864/v1`（服务在其他机器时填写对应地址）
- API 协议：`openai-responses`；API 密钥：在 WorkBuddy Manager 面板创建的网关密钥
- 模型：选择「获取可用模型」或手动填写网关允许的模型，例如 `glm-5.2`

保存后即可在模型选择器中选择该提供方。这种方式沿用桌面版已有模型配置，适合已配置其他提供方的用户。

## Bundle 安装

桌面版可在侧栏选择**插件 → 添加插件**，输入本地安装包的绝对路径并启用。若你的 profile 已配置 `llm-pi-ai`，请按下方「配置与边界」的说明合并 provider，或使用上面的桌面版模型设置。

1. **准备服务端**：按上游文档部署 WorkBuddy Manager（默认 `http://127.0.0.1:7864`），在「密钥」页创建一把网关密钥 `wbk_...`，并记录它允许调用的模型。
2. **写入密钥**：把密钥放到 DSH 凭据里，配置层只引用变量名，不含任何明文：
   ```yaml
   # $DSH_HOME/.credentials.yaml
   version: 1
   refs:
     WORKBUDDY_MANAGER_API_KEY: wbk_xxxxxxxx
   ```
   也可以启动 DSH 时带上同名环境变量（`WORKBUDDY_MANAGER_API_KEY=... dsh`），或写入 `.env`；存储文件优先级最高。
3. **安装插件**：
   ```sh
   dsh plugin --profile demo add ./dsh-workbuddy-manager-0.1.0.tgz
   # 或发布到 npm 后： dsh plugin --profile demo add dsh-workbuddy-manager
   dsh --profile demo --dump-config   # 应能看到本 bundle 的配置层
   ```
4. **验证**：`dsh --profile demo` 启动后，在模型选择器里选 `WorkBuddy Manager / glm-5.2`；或用 CLI 体检：
   ```sh
   WORKBUDDY_MANAGER_API_KEY=wbk_xxxxxxxx node ./lib/cli.js doctor
   ```

## 只读 CLI

`dsh-workbuddy doctor | status | models | usage | me | accounts | credits`，`--json` 输出紧凑 JSON 便于脚本处理。管理面命令需要只读令牌 `wbt_...`（环境变量 `WORKBUDDY_MANAGER_READONLY_TOKEN`）。CLI 只做只读查询，**不提供**扫码纳管、签到、账号增删或密钥管理。

## 配置与边界

- `cordis.patch.yml` 是 DSH 侧连接配置的唯一来源（地址、协议、模型目录、兼容开关）。改地址/加模型/换协议请看仓库 `docs/usage.md`。
- bundle 按 id 覆盖 `dsh-base` 里零路由休眠挂载的 `llm-pi-ai` 行；DSH 的 patch 语义是「后写者胜、整行替换 config」。若你在 profile 或 home 层也覆盖了该行，请把 workbuddy-manager 的 provider 块并入那一层。
- 使用边界遵循上游项目：仅限管理本人及亲属自愿授权的账号，自用与学习研究；禁止批量注册、账号交易、绕过平台风控以及任何商业转售用途。本项目与腾讯、CodeBuddy 官方无隶属关系。

完整安装、故障排查与开发说明见仓库 `docs/usage.md`（不随插件包分发）。插件自身代码按 MIT 许可。
