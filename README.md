# dsh-workbuddy-manager

在 DeepSeek Harness 中登录并管理 [WorkBuddy Manager](https://github.com/ithtelab/workbuddy-manager) 账号池，自动连接模型；也可继续使用已有网关密钥。

## 安装与使用

需要 DSH `0.2.2-rc.1` 和 WorkBuddy Manager `2.11.10` 的桥接镜像。

1. 在项目目录构建账号池桥接镜像：

   ```sh
   docker build -t dsh-workbuddy-bridge:2.11.10 -f bridge/Dockerfile bridge
   ```

2. 将现有 WorkBuddy Manager 的 `manager` 服务切换为该镜像，保留原有配置和数据卷。Compose 部署可叠加 `bridge/compose.yaml`；具体命令见仓库 `docs/usage.md`。
3. 执行 `npm pack`，在 DSH **插件**页面安装生成的安装包并启用，然后完全退出并重启 DSH。
4. 打开 **设置 → WorkBuddy**，填写账号池地址并使用管理员账号登录；添加账号时可扫码、复制链接或打开链接完成授权。
5. 插件自动连接并同步模型，在对话的模型选择器中选择 **WorkBuddy 账号池**。

桥接使用仅限模型调用的登录会话，保存在 DSH 凭据服务中。模型调用使用账号池默认上游并消耗账号积分；管理会话失效后需要重新登录。已有网关密钥和其他模型提供方保持可用。

## 只读命令行

`dsh-workbuddy doctor | status | models | usage | me | accounts | credits`；添加 `--json` 可输出紧凑 JSON。管理面查询使用只读令牌环境变量 `WORKBUDDY_MANAGER_READONLY_TOKEN`，网关查询使用 `WORKBUDDY_MANAGER_API_KEY`。

使用须遵守上游项目的授权和使用规则。本项目与腾讯、CodeBuddy 官方无隶属关系。
