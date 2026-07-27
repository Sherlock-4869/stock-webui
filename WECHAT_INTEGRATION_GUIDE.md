# 普通微信公众号每周打新消息接入与部署指南

本文档对应当前项目已经实现的微信公众号接入代码，目标是：

- 继续使用现有 Node.js 服务，不新增另一套系统。
- 使用普通公众号的文本客服消息接口，不使用模板消息。
- 自动记录关注用户的 OpenID 和提醒开关。
- 每周一 `09:00`（`Asia/Shanghai`）汇总并发送本周可申购新股。
- 点击文本中的链接进入 `https://stock.sherlock-holmes.cn/?page=ipo`。
- 使用 MySQL 保存关注者、任务和发送结果，防止重复发送。
- 微信返回权限、频率、互动窗口等错误时如实记录，不把失败误报为成功。

## 1. 必须先了解的接口边界

普通订阅号可以在微信公众平台后台人工群发消息，但“后台人工群发”和“服务器通过 API 自动发送”是两个不同能力。

当前代码按照需求调用文本客服消息接口：

```http
POST https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=ACCESS_TOKEN
```

请求内容：

```json
{
  "touser": "用户OPENID",
  "msgtype": "text",
  "text": {
    "content": "本周打新汇总"
  }
}
```

微信官方当前文档将公众号客服消息接口标记为企业主体认证账号可调用。普通未认证个人订阅号实际调用时，可能返回：

- `48001`：当前账号没有该 API 权限。
- `45015`：客服消息发送超出允许的互动时间范围。
- `40003`：OpenID 不合法或用户已经取消关注。
- `40164`：服务器出口 IP 未加入 API IP 白名单。

用户已经明确要求系统不要预先判断互动时间，因此当前代码仍会在每周一发起调用，并将微信的真实返回结果写入数据库。若微信返回 `48001`，代码本身无法绕过微信账号权限，需要改用有权限的账号或改为公众平台后台人工群发。

- [发送客服消息官方文档](https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html)
- [根据 OpenID 群发消息官方文档](https://developers.weixin.qq.com/doc/service/api/notify/message/api_masssend.html)

## 2. 已经添加到项目的能力

项目增加了以下文件：

```text
.env.example                    环境变量示例
package.json                    项目依赖和检查命令
package-lock.json               依赖锁定文件
database/wechat_schema.sql      微信推送建表 SQL
wechat/config.js                配置读取和校验
wechat/client.js                access_token 和客服消息 API
wechat/database.js              MySQL 数据访问和自动建表
wechat/service.js               回调、内部接口、调度和发送流程
wechat/weekly-ipo.js            本周日期及打新汇总
wechat/xml.js                   微信 XML 消息解析和回复
test/wechat.test.js             核心逻辑测试
```

现有文件的调整：

- `server.js` 增加微信路由，并在服务启动后启动微信调度器。
- `run.sh` 启动时自动读取项目 `.env`，不会修改系统全局环境变量。
- `public/index.html` 支持通过 `?page=ipo` 直接打开打新页面。
- `.gitignore` 排除 `.env`、`node_modules` 和运行日志。

## 3. 完整逻辑流程

```text
用户关注公众号或向公众号发消息
              ↓
微信 POST /wechat/callback
              ↓
验证 signature、timestamp、nonce
              ↓
从 XML 中取得用户 OpenID
              ↓
写入 wechat_subscribers

每周一上海时间 09:00
              ↓
调用现有 loadIpoCalendar()
              ↓
筛选本周一至本周日 applyDate
              ↓
生成一条文本汇总
              ↓
数据库 GET_LOCK 防止多实例并发
              ↓
创建 weekly-ipo:YYYY-MM-DD 唯一任务
              ↓
读取 subscribed=1 且 ipo_notify_enabled=1 的 OpenID
              ↓
逐个调用微信客服文本消息接口
              ↓
记录 sent 或 failed 及微信错误码
```

即使服务在周一 `09:00` 没有运行，只要 `STOCK_WECHAT_SCHEDULE_CATCHUP=true`，当天稍后恢复运行时仍会补执行。数据库中的周任务唯一键保证同一周不会成功发送两次。

如果本周没有新股，系统仍会发送：

```text
本周暂无可申购新股。
```

## 4. 第一步：立即重置已经暴露的密码

之前在对话中出现过公众号 AppSecret 和数据库 root 密码。上线前必须：

1. 在微信开发者平台重置 AppSecret。
2. 修改 MySQL root 密码。
3. 为本应用创建专用数据库账号，不让 Node.js 长期使用 root。
4. 新密码只写入云服务器 `.env`，不要再次发送到聊天中。

代码和本文档都没有保存已暴露的密码。

## 5. 第二步：准备 MySQL

数据库地址为：

```text
172.16.0.13:3306
数据库：stock
```

### 5.1 创建应用专用账号

使用数据库管理员登录 MySQL，执行下面的 SQL。必须将占位内容替换为真实值：

```sql
CREATE DATABASE IF NOT EXISTS stock
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 将 <应用服务器私网IP> 换成运行 Node.js 的云服务器私网 IP。
-- 将 <随机强密码> 换成新生成的强密码。
CREATE USER IF NOT EXISTS 'stock_wechat'@'<应用服务器私网IP>'
  IDENTIFIED BY '<随机强密码>';

GRANT SELECT, INSERT, UPDATE, CREATE, INDEX, REFERENCES
  ON stock.*
  TO 'stock_wechat'@'<应用服务器私网IP>';

FLUSH PRIVILEGES;
```

如果 Node.js 和 MySQL 之间的源地址会变化，可以使用受控网段，例如 `172.16.0.%`，但精确到应用服务器私网 IP 更安全。不要配置为 `'%'`，也不要把 MySQL `3306` 端口开放到公网。

### 5.2 建表 SQL

完整 SQL 也保存在 `database/wechat_schema.sql`。使用 root 或有建表权限的账号执行：

```sql
USE stock;

CREATE TABLE IF NOT EXISTS wechat_subscribers (
  openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subscribed TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否仍关注公众号',
  ipo_notify_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否接收每周打新提醒',
  source VARCHAR(32) NOT NULL DEFAULT 'callback',
  last_interaction_at DATETIME NULL,
  subscribed_at DATETIME NULL,
  unsubscribed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (openid),
  KEY idx_wechat_subscribers_notify (subscribed, ipo_notify_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wechat_push_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  ipo_count INT UNSIGNED NOT NULL DEFAULT 0,
  message_content TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  recipient_count INT UNSIGNED NOT NULL DEFAULT 0,
  success_count INT UNSIGNED NOT NULL DEFAULT 0,
  failure_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(1000) NULL,
  scheduled_for DATETIME NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_wechat_push_jobs_job_key (job_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wechat_push_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id BIGINT UNSIGNED NOT NULL,
  openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  wechat_errcode INT NULL,
  wechat_errmsg VARCHAR(1000) NULL,
  started_at DATETIME NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_wechat_delivery_job_user (job_id, openid),
  KEY idx_wechat_delivery_status (job_id, status),
  CONSTRAINT fk_wechat_delivery_job
    FOREIGN KEY (job_id) REFERENCES wechat_push_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

应用启动时也会执行相同的 `CREATE TABLE IF NOT EXISTS`，因此不会删除或覆盖已有数据。

## 6. 第三步：配置项目环境变量

在云服务器项目目录执行：

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```env
STOCK_WECHAT_ENABLED=true
STOCK_WECHAT_APP_ID=填写公众号AppID
STOCK_WECHAT_APP_SECRET=填写重置后的新AppSecret
STOCK_WECHAT_CALLBACK_TOKEN=填写随机回调Token
STOCK_WECHAT_PAGE_URL=https://stock.sherlock-holmes.cn/?page=ipo
STOCK_WECHAT_ADMIN_KEY=填写内部管理接口随机密钥
STOCK_WECHAT_AUTO_ENABLE=true
STOCK_WECHAT_TIMEZONE=Asia/Shanghai
STOCK_WECHAT_SCHEDULE_WEEKDAY=1
STOCK_WECHAT_SCHEDULE_HOUR=9
STOCK_WECHAT_SCHEDULE_MINUTE=0
STOCK_WECHAT_SCHEDULE_CATCHUP=true

STOCK_DB_HOST=172.16.0.13
STOCK_DB_PORT=3306
STOCK_DB_USER=stock_wechat
STOCK_DB_PASSWORD=填写应用数据库账号的新密码
STOCK_DB_NAME=stock
STOCK_DB_CONNECTION_LIMIT=5
```

随机生成回调 Token 和内部管理密钥。微信回调 Token 需要使用 3～32 位英文字母或数字，因此使用 16 个随机字节生成 32 位十六进制字符串：

```bash
openssl rand -hex 16
openssl rand -hex 32
```

两个命令的结果分别填入：

```text
STOCK_WECHAT_CALLBACK_TOKEN
STOCK_WECHAT_ADMIN_KEY
```

不要将 `.env` 提交到 Git。`run.sh` 会在每次启动时读取 `.env` 并仅注入当前 Node.js 进程，不会占用或修改系统全局环境变量。

## 7. 第四步：安装依赖

先确认 Node.js 版本不低于 18：

```bash
node -v
```

在项目目录执行：

```bash
npm install
```

当前新增的运行依赖只有 MySQL 驱动 `mysql2`。

安装后检查：

```bash
npm run check
npm test
```

## 8. 第五步：配置微信开发者平台

开发接口已经迁移到微信开发者平台：

1. 打开 [微信开发者平台](https://developers.weixin.qq.com/platform/)。
2. 扫码登录。
3. 进入“我的业务”。
4. 进入“公众号”并选择当前账号。
5. 在“基础信息”中查看 AppID。
6. 在“开发密钥”中重置 AppSecret，并配置 API IP 白名单。
7. 在“域名与消息推送配置”中配置消息推送。

[开发接口管理升级说明](https://developers.weixin.qq.com/doc/service/guide/dev/migration.html)

### 8.1 API IP 白名单

填写 Node.js 云服务器访问 `api.weixin.qq.com` 时的公网出口 IP。该地址不是 MySQL 私网 IP，也不一定与域名解析 IP 相同。

未配置正确时，获取 access_token 或调用接口可能返回 `40164`。

### 8.2 消息推送配置

填写：

```text
URL：https://stock.sherlock-holmes.cn/wechat/callback
Token：与 .env 的 STOCK_WECHAT_CALLBACK_TOKEN 完全相同
消息加解密方式：明文模式
```

当前代码实现的是明文回调。暂时不要选择安全模式；安全模式会带有 `encrypt_type=aes`，当前服务会明确拒绝，避免把加密内容当成普通 XML 处理。

保存时微信会请求：

```http
GET /wechat/callback?signature=...&timestamp=...&nonce=...&echostr=...
```

服务验证 SHA1 签名后原样返回 `echostr`。

启用消息推送后，平台原有自动回复能力可能受影响。当前代码已经接管以下文本回复：

```text
打新 / 开启打新      开启每周提醒
取消打新 / 关闭打新  关闭每周提醒
本周打新 / 本周新股  立即被动回复本周新股
```

## 9. 第六步：确认 Nginx 转发

现有 Nginx 已经反向代理到 Node.js。需要确保所有路径都被转发，而不是只转发 `/api/`。

参考配置：

```nginx
server {
    listen 443 ssl http2;
    server_name stock.sherlock-holmes.cn;

    # 证书配置保持现有设置

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

检查并重载：

```bash
sudo nginx -t
sudo nginx -s reload
```

微信验证依赖 URL 查询参数，不能在 Nginx 中删除 `signature`、`timestamp`、`nonce` 或 `echostr`。

## 10. 第七步：启动服务

当前项目仍然使用原来的运行方式：

```bash
./run.sh restart
./run.sh check
```

`run.sh` 会在自己的进程中读取 `.env`，导出其中的变量后启动 Node.js，等价于：

```bash
set -a
. ./.env
set +a
node server.js
```

这种方式兼容不支持 `node --env-file` 的旧版 Node.js；变量只会传给本次启动的 Node.js 进程，不会写入系统全局环境。因为 `.env` 按 shell 配置读取，如果密码包含空格、`#`、`$` 等 shell 特殊字符，需要使用单引号包裹，例如 `STOCK_DB_PASSWORD='实际密码'`。

正常日志应包含：

```text
Stock monitor running at http://localhost:3000
WeChat weekly IPO notification ready (Asia/Shanghai, weekday=1, 09:00)
```

如果数据库或微信配置不正确，现有股票页面仍会启动，日志会单独显示微信模块初始化失败。

## 11. 第八步：让系统取得个人 OpenID

最简单方式：

1. 启用微信消息推送配置。
2. 用个人微信取消关注后重新关注公众号，或者给公众号发送任意文字。
3. 微信调用 `/wechat/callback`。
4. 系统从 `FromUserName` 得到 OpenID 并写入 `wechat_subscribers`。

由于：

```env
STOCK_WECHAT_AUTO_ENABLE=true
```

新关注用户默认开启提醒。用户回复“取消打新”可关闭。

对于接入前已经关注且不方便重新关注的用户，可以尝试同步接口：

```bash
curl -X POST \
  -H 'X-Admin-Key: <STOCK_WECHAT_ADMIN_KEY的值>' \
  https://stock.sherlock-holmes.cn/internal/wechat/subscribers/sync
```

该接口调用微信关注者列表 API。如果普通账号没有该接口权限，会返回微信错误；此时使用“给公众号发消息”或“重新关注”的方式取得 OpenID。

检查数据库：

```sql
SELECT openid, subscribed, ipo_notify_enabled, source,
       last_interaction_at, subscribed_at, unsubscribed_at
FROM stock.wechat_subscribers
ORDER BY updated_at DESC;
```

## 12. 内部管理接口

所有 `/internal/wechat/` 接口必须携带：

```http
X-Admin-Key: STOCK_WECHAT_ADMIN_KEY的值
```

或者：

```http
Authorization: Bearer STOCK_WECHAT_ADMIN_KEY的值
```

Nginx 不应记录该请求头，也不要把管理密钥放入浏览器前端代码。

### 12.1 查看状态

```bash
curl \
  -H 'X-Admin-Key: <管理密钥>' \
  https://stock.sherlock-holmes.cn/internal/wechat/status
```

返回内容不包含 AppSecret、数据库密码或 access_token。

### 12.2 只预览、不发送

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  'https://stock.sherlock-holmes.cn/internal/wechat/ipo/run?dry_run=1'
```

返回：

```json
{
  "dryRun": true,
  "weekStart": "2026-07-27",
  "weekEnd": "2026-08-02",
  "ipoCount": 2,
  "content": "【本周新股申购】..."
}
```

这一步不会创建发送任务，也不会调用微信发送接口。

### 12.3 手动执行本周推送

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  https://stock.sherlock-holmes.cn/internal/wechat/ipo/run
```

同一周任务已经成功完成时，再次调用不会重复发送。

### 12.4 重试本周失败用户

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  'https://stock.sherlock-holmes.cn/internal/wechat/ipo/run?retry_failed=1'
```

只有确认失败原因已经排除后才应执行重试。

## 13. 定时规则

默认配置：

```text
时区：Asia/Shanghai
星期：1，即周一
时间：09:00
补执行：开启
```

调度器每 30 秒检查一次时间。到达周一 `09:00` 后，数据库创建：

```text
weekly-ipo:本周一日期
```

例如：

```text
weekly-ipo:2026-07-27
```

该字段具有唯一索引。单进程重启、周一补执行和多实例同时运行都不会创建第二个相同任务；MySQL `GET_LOCK` 还会阻止多实例同时发送。

## 14. 消息内容示例

```text
【本周新股申购】
2026-07-27 至 2026-08-02

共 2 只：
1. 测试股份（787001）
   2026-07-28 周二｜发行价 12.50元
2. 示例科技（301002）
   2026-07-30 周四｜发行价 待公布

详情：https://stock.sherlock-holmes.cn/?page=ipo
数据以交易所最终公告为准，不构成投资建议。
```

最多列出 20 只，文本总长度限制在约 1900 字符内，避免超过微信文本消息长度限制。

## 15. 数据库状态说明

### 15.1 `wechat_subscribers`

保存：

- 用户 OpenID。
- 是否仍关注公众号。
- 是否开启打新提醒。
- OpenID 来源。
- 最近互动时间。

### 15.2 `wechat_push_jobs`

每周最多一条任务，状态包括：

```text
pending
running
completed
failed
```

查询最近任务：

```sql
SELECT id, job_key, week_start, week_end, ipo_count, status,
       recipient_count, success_count, failure_count,
       last_error, started_at, finished_at
FROM stock.wechat_push_jobs
ORDER BY id DESC
LIMIT 20;
```

### 15.3 `wechat_push_deliveries`

记录每个用户的实际发送结果：

```sql
SELECT d.id, d.job_id, d.openid, d.status, d.attempt_count,
       d.wechat_errcode, d.wechat_errmsg, d.started_at, d.sent_at
FROM stock.wechat_push_deliveries d
ORDER BY d.id DESC
LIMIT 100;
```

只有微信返回：

```json
{"errcode":0,"errmsg":"ok"}
```

系统才会把 delivery 标记为 `sent`。

## 16. 常见问题排查

### 16.1 `48001 api unauthorized`

当前普通订阅号没有客服消息 API 权限。登录微信开发者平台查看“接口管理 → 接口权限与额度”。这属于微信账号权限，不是域名、Nginx、Node.js 或数据库故障。

### 16.2 `40164 invalid ip`

Node.js 服务器的公网出口 IP 没有加入 API IP 白名单，或者服务器经过 NAT 后出口 IP 与预期不同。

### 16.3 `40001 invalid credential`

检查 AppID 与 AppSecret 是否属于同一个公众号；重置 AppSecret 后必须同步更新 `.env` 并重启服务。

### 16.4 `45015 response out of time limit`

微信拒绝在允许时间范围外发送客服消息。当前代码不会预判，而是记录该错误。解决方案只能遵循微信允许的消息通道或更换适用账号能力。

### 16.5 回调配置验证失败

检查：

- URL 必须是 `https://stock.sherlock-holmes.cn/wechat/callback`。
- 微信后台 Token 与 `.env` 完全一致。
- 当前选择明文模式。
- Node.js 服务已经重启并成功读取 `.env`。
- Nginx 转发了完整路径和查询参数。
- HTTPS 证书有效且外网可访问。

### 16.6 没有接收用户

检查 `wechat_subscribers`。用户需要在启用回调后重新关注或向公众号发送消息，系统才能从回调取得 OpenID。

### 16.7 周一重复调用

正常情况下不会重复发送。检查：

```sql
SELECT * FROM stock.wechat_push_jobs
WHERE job_key = 'weekly-ipo:对应周一日期';
```

不要为了重发而手工删除生产发送记录，否则会失去防重依据。

## 17. 推荐的首次上线验证顺序

1. 重置公众号 AppSecret 和数据库 root 密码。
2. 创建 `stock_wechat` 数据库账号。
3. 执行建表 SQL。
4. 在云服务器创建权限为 `600` 的 `.env`。
5. 执行 `npm install`、`npm run check` 和 `npm test`。
6. 先保持 `STOCK_WECHAT_ENABLED=false`，确认原股票服务正常。
7. 改为 `true` 并执行 `./run.sh restart`。
8. 调用 `/internal/wechat/status` 确认 `ready=true`。
9. 在微信开发者平台配置 API IP 白名单。
10. 配置明文消息回调 URL 和 Token。
11. 重新关注公众号或向公众号发送消息。
12. 检查 `wechat_subscribers` 是否出现 OpenID。
13. 调用 `dry_run=1` 检查本周数据和文本内容。
14. 手动执行一次本周推送。
15. 检查 `wechat_push_deliveries` 的微信错误码。
16. 若返回 `errcode=0`，再等待下一个周一自动执行。

## 18. 安全要求

- 不要把 `.env`、AppSecret、管理密钥或数据库密码提交到 Git。
- 不要通过网页 JavaScript 读取这些值。
- 不要在日志中打印 access_token、AppSecret 或数据库密码。
- 内部管理接口必须保留强随机 `STOCK_WECHAT_ADMIN_KEY`。
- MySQL 只允许应用服务器私网 IP 访问。
- Node.js 使用专用低权限数据库账号，禁止使用 root 长期运行。
- 定期检查 `wechat_push_deliveries` 中的异常错误码。
- AppSecret 或数据库密码泄漏后立即轮换，而不是只删除聊天消息。

## 19. 当前实现范围

当前已经实现：

- 明文微信回调验证。
- 关注、取消关注、文本消息和菜单事件处理。
- OpenID 与提醒状态持久化。
- access_token 缓存和失效刷新。
- 客服文本消息发送。
- 本周 IPO 计算和消息生成。
- 每周一 `09:00` 调度及当天补执行。
- MySQL 分布式锁和唯一键防重。
- 逐用户发送结果和错误码记录。
- 手动预览、执行、失败重试和用户同步接口。
- `?page=ipo` 页面直达。

当前没有实现：

- 模板消息。
- 安全模式回调的 AES 加解密。
- 绕过微信对普通订阅号的 API 权限限制。
- 绕过微信对客服消息发送时机的限制。
- 微信公众平台后台群发的自动化操作。

最后三项属于微信平台规则或后台能力，无法仅通过服务器代码规避。
