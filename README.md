# dsh-workbuddy-manager

在 DeepSeek Harness 中管理 [WorkBuddy Manager](https://github.com/ithtelab/workbuddy-manager) 网关连接：检查服务状态、安全保存网关密钥，并将可用模型同步到 DSH 模型选择器。

## 安装与使用

需要 DSH `0.2.2-rc.1` 和已运行的 WorkBuddy Manager 服务。

1. 在 WorkBuddy Manager 管理页面创建网关密钥，并确认该密钥允许使用的模型。
2. 在 DSH 的**插件**页面安装并启用本插件；从源码构建时可先执行 `npm pack`，再选择生成的安装包。
3. 打开 DSH **设置 → WorkBuddy**，填写网关地址和密钥，点击**保存并同步模型**。本机默认地址是 `http://127.0.0.1:7864`，非本机网关使用 HTTPS。
4. 在对话的模型选择器中选择 WorkBuddy Manager 下的模型。需要管理账号或网关密钥时，点击插件中的**打开管理页面**。

插件通过 DSH 凭据服务保存密钥，模型通过 DSH 官方 `llm-pi-ai` 适配器调用。已有 WorkBuddy 提供方会保留密钥引用、模型设置及高级选项；其他提供方不受影响。同步会添加新发现的模型，已有模型不会被删除或覆盖。

网关服务由现有部署方式管理；插件显示连接状态并提供管理页面入口。

## 只读命令行

`dsh-workbuddy doctor | status | models | usage | me | accounts | credits`；添加 `--json` 可输出紧凑 JSON。管理面查询需要设置只读令牌环境变量 `WORKBUDDY_MANAGER_READONLY_TOKEN`，网关查询使用 `WORKBUDDY_MANAGER_API_KEY`。

使用须遵守上游项目的授权和使用规则。本项目与腾讯、CodeBuddy 官方无隶属关系。完整安装和排障说明见仓库 `docs/usage.md`。
