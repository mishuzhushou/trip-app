# 行程助手（企业微信自建应用 H5）部署与使用指南

> 高管行程登记与约车提醒，秘书在企业微信里点开即用，iPhone/安卓通吃，全程免费。

## 一、项目结构

```
trip-helper/
├── server.js            # 服务入口（H5 + REST API + 定时提醒入口）
├── src/
│   ├── db.js            # 数据层（JSON 文件存储，data/db.json）
│   ├── wecom.js         # 企微对接（token 缓存 / 应用消息 / 群机器人）
│   ├── parser.js        # 行程文本解析（火车/航班订单）
│   └── remind.js        # 约车提醒引擎（8:00 晨间 / 17:00 截止，去重+脱敏）
├── public/              # H5 前端（登录/看板/登记/管理）
├── scripts/smoke.js     # 冒烟测试脚本
└── package.json
```

## 二、本地运行（验证用）

```bash
cd trip-helper
npm install
# Windows CMD（一行）：
set WECOM_CORPID=你的corpid&& set WECOM_SECRET=你的Secret&& set WECOM_AGENTID=1000122&& node server.js
```

打开 http://localhost:3000 —— 系统无账号时，页面注册的第一个账号自动成为管理员。

## 三、云端部署（免费方案：Render 免费档，自带固定出口 IP）

1. 把 `trip-helper` 目录推到一个 GitHub 仓库（私有仓库即可）。
2. 注册 https://render.com（免费，邮箱即可）→ New → Web Service → 连接该仓库。
3. 配置：
   - Runtime: Node；Build Command: `npm install`；Start Command: `node server.js`
   - 环境变量（Environment）：
     | Key | Value |
     |---|---|
     | WECOM_CORPID | wx9918c64b97fda541 |
     | WECOM_SECRET | （管理员给的 Secret） |
     | WECOM_AGENTID | 1000122 |
     | APP_HOME_URL | 部署完成后填应用首页地址（提醒卡片点击落地页） |
4. 部署完成后拿到网址（形如 https://trip-helper-xxxx.onrender.com）。
5. **关键一步（可信IP）**：Render 服务详情页有 "Outbound IP"（固定出口 IP，可能有 2~3 个），把全部 IP 发给企微管理员，在自建应用详情页「企业可信IP / IP白名单」里逐个填入。**不填则提醒推送会报 60020。**
6. （可选）把应用主页地址填进企微后台自建应用的「应用主页」，秘书工作台点图标直达。

## 四、定时提醒（免费双源）

用 https://cron-job.org（免费注册）建两个定时任务，访问地址：

```
https://你的域名/api/cron/remind?mode=morning&key=你的cronKey
https://你的域名/api/cron/remind?mode=deadline&key=你的cronKey
```

- `morning` 每天 08:00 触发；`deadline` 每天 17:00 触发（cron-job.org 里设置北京时间）。
- `cronKey` 在应用「管理 → 提醒设置」页生成。
- 去重：同一天同一时段只推一次；手动测试可在地址后加 `&force=1`（忽略去重）。
- 建议再配第二个免费定时源（如 UptimeRobot 的 HTTP 监控）做备份，去重机制保证不会重复推送。

## 五、秘书使用流程

1. 管理员在应用「管理」页：新增高管 → 新增秘书账号 → 给秘书分配分管高管 → 填秘书的**企微 userid**（用于定向提醒；可在企微通讯录该成员资料页查看账号/ID）。
2. 秘书登录 → 「登记行程」：可**拍照/选图识别**（OCR 自动提取车次时间），或粘贴订单短信 → 智能解析 → 核对 → 逐条保存。
3. 到点自动收到企微提醒卡片（只报条数，不含具体行程）；点开处理并勾选「已约车」。
4. 全部约好后当天不再推送。

## 五-1、OCR 配置（拍照识别行程）

- 用途：秘书拍订单截图/纸质票据，自动识别成文字并解析成行程。
- 方案：腾讯云文字识别（GeneralBasicOCR），免费额度约 **1000 次/月**。
- 配置步骤：
  1. 注册 https://cloud.tencent.com （个人实名即可，免费）；
  2. 控制台搜索「文字识别」→ 开通服务（按量计费，免费额度内不产生费用）；
  3. 「访问管理 CAM」→ API 密钥管理 → 新建密钥，得到 SecretId / SecretKey；
  4. 在 Render 环境变量加：
     | Key | Value |
     |---|---|
     | TENCENT_SECRET_ID | 你的 SecretId |
     | TENCENT_SECRET_KEY | 你的 SecretKey |
     | TENCENT_OCR_REGION | ap-guangzhou（默认，可不填） |
- 未配置时：拍照按钮会提示"OCR 未配置"，粘贴文本方式仍可正常使用（不影响其他功能）。

## 六、安全要点

- Secret / cronKey 只存在服务端环境变量，不进代码与页面。
- 行程数据存服务端 data/db.json，与企微完全隔离；管理员（企微侧）看不到任何行程。
- 提醒消息脱敏：只写"待约 N 条"，具体行程需登录后查看。

## 七、数据备份

数据全部在 `data/db.json` 一个文件里，定期下载备份即可（Render 免费档磁盘会随实例重建而清空，**建议 cron 任务顺带把 db.json 定期备份到外部**，或升级到挂载磁盘方案时告诉我）。
