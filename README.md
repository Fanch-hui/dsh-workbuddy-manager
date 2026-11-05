# dsh-workbuddy-manager

在 DeepSeek Harness 宿主内直接登录管理 WorkBuddy 账号池（支持国内版 `copilot.tencent.com` 与国际版 `www.workbuddy.ai`），通过内置本地网关自动发现并调用模型；同时保留自定义网关连接与只读 CLI。

## 安装与使用

需要 DSH `0.2.2-rc.1`。

1. 在项目目录执行 `npm pack`，在 DSH **插件**页面安装生成的安装包并启用，然后完全退出并重启 DSH。
2. 打开 **设置 → WorkBuddy**，在 **添加 WorkBuddy 账号** 中选择国内版或国际版，点击 **获取登录链接或扫码**。
3. 扫码或打开授权链接完成确认，账号会自动加入宿主账号池并保存在 DSH 凭据服务中。
4. 插件自动在 `127.0.0.1:随机端口` 启动带临时密钥的本地网关并同步模型，在对话的模型选择器中选择 **WorkBuddy 账号池** 下的模型即可使用。

## 只读命令行

`dsh-workbuddy doctor | status | models | usage | me | accounts | credits`；添加 `--json` 可输出紧凑 JSON。管理面查询使用只读令牌环境变量 `WORKBUDDY_MANAGER_READONLY_TOKEN`，网关查询使用 `WORKBUDDY_MANAGER_API_KEY`。

使用须遵守上游服务授权和使用规则（仅限本人及亲属自愿授权账号，禁止批量注册、账号交易、绕过风控与商业转售）。本项目与腾讯、CodeBuddy 官方无隶属关系。
