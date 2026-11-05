# dsh-workbuddy-manager

在 DeepSeek Harness 中管理已部署的 [WorkBuddy Manager](https://github.com/ithtelab/workbuddy-manager)：登录管理服务、扫码添加账号、启停账号及网关密钥，并将模型同步到 DSH。

## 安装与使用

需要 DSH `0.2.2-rc.1` 和已运行的 WorkBuddy Manager 服务。

1. 在 DSH 的**插件**页面安装并启用本插件；从源码构建时可先执行 `npm pack`，再选择生成的安装包，然后重启 DSH。
2. 打开 DSH **设置 → WorkBuddy**。本机默认地址为 `http://127.0.0.1:7864`，远程服务使用 HTTPS。
3. 使用 WorkBuddy Manager 的管理用户名和密码登录，在插件内查看账号、扫码添加账号，以及创建或启停网关密钥。
4. 选择网关密钥的**用于 DSH**，插件将安全保存该密钥并同步模型。也可手动输入网关密钥后点击**保存并同步模型**。
5. 在对话的模型选择器中选择 WorkBuddy Manager 下的模型。

管理会话和网关密钥通过 DSH 凭据服务保存，管理密码不会保存；会话过期后需要重新登录。同步只修改所选 WorkBuddy 提供方并追加新模型，保留其他提供方和已有模型设置。管理密钥新建时默认不限额度，创建前请确认。

网关进程或容器仍由现有部署方式启停。

## 只读命令行

`dsh-workbuddy doctor | status | models | usage | me | accounts | credits`；添加 `--json` 可输出紧凑 JSON。管理面查询需要设置只读令牌环境变量 `WORKBUDDY_MANAGER_READONLY_TOKEN`，网关查询使用 `WORKBUDDY_MANAGER_API_KEY`。

使用须遵守上游项目的授权和使用规则。本项目与腾讯、CodeBuddy 官方无隶属关系。完整安装和排障说明见仓库 `docs/usage.md`。
