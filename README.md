# Stock Monitor：股票监控与微信公众号打新提醒

这是一个直接运行于 Node.js 的股票监控服务，提供自选股行情、全球市场概览、K 线、异动消息和新股申购日历，并在现有服务中集成微信公众号回调、菜单以及每周汇总和当日打新提醒。

主要能力：

- 浏览自选股、全球指数、K 线和打新日历；主力资金历史数据统一采用东方财富口径。
- 支持账号密码注册/登录、微信开放平台扫码登录及安全会话。
- 登录后按账号同步自选股、分组、主题、指标等页面配置；主题提供云白、暖纸、石墨、深海、松林、暮紫及跟随系统。
- 账户设置支持修改显示名称、上传、裁切和压缩个人头像；未设置自定义头像时继续使用微信头像或名称首字。
- 登录账号可以创建、编辑、删除、搜索和导入 Markdown 笔记；支持账号级文件夹分类，并可在左侧“文件列表 / 标题导航”之间切换。
- 登录账号可以进入支持持久化历史、图片、剪贴板图片粘贴、表情、缩放和未读数字提示的网页聊天室；游客不可访问。
- 管理员可配置网站全局 OpenAI 兼容模型、统一控制 AI 问股页面是否向已登录用户公开，或在用户管理中逐个授权，并查看按用户/模型汇总的 Token 用量；用户已配置个人模型时优先使用个人模型，否则使用有权限访问的网站模型；会话和历史按账号隔离保存。
- 侧边栏“站点推荐”打开站内资源目录，集中展示数据库驱动的推荐链接，并在新标签页中打开。
- 参考文档默认在当前页面内阅读，支持目录定位、重新加载、下载 Markdown 和新窗口打开。
- 通过 `https://stock.sherlock-holmes.cn/?page=ipo` 直接打开打新页面。
- 接收公众号关注、取消关注、文本消息和自定义菜单事件。
- 每周一 `09:00` 按上海时区汇总本周可申购新股。
- 每天 `09:00` 检查当日可申购新股，有数据时追加发送当日提醒，无数据时不推送。
- 推送内容会逐只标注所属板块（如创业板、科创板、沪市主板、深市主板），并包含名称、申购代码、申购日期和发行价。
- 使用 MySQL 保存关注者、任务和逐用户发送结果。

## 快速启动

环境要求：Node.js 18 及以上版本、npm 和 MySQL。

```bash
cp .env.example .env
./run.sh install
./run.sh verify
./run.sh start
./run.sh check
```

不开启账号、微信公众号或 AI 问股功能时，分别保持 `.env` 中对应开关为 `false`，原有未登录股票页面仍按之前方式运行。AI 问股还需启动独立的 `stock-api-agent` Python 服务，完整配置见下文。

## 账号体系

### 功能与数据切换规则

- 未登录时继续使用当前浏览器 LocalStorage，页面默认行为不变。
- 账号首次登录会询问是否关联当前页面配置。选择“关联当前配置”后，自选股、分组、主题、指标、行情颜色、刷新频率、当前页面和异动记录会保存到该账号。
- 选择“使用账户默认配置”时，不导入登录前数据，账号从系统默认配置开始。
- 已有账号配置时，登录后优先加载账号配置，并在页面发生变化后自动同步。
- 登录前的访客配置会单独备份；退出登录后恢复访客配置，避免把账号数据遗留给未登录页面。
- 密码使用 Node.js 原生 `scrypt` 加盐哈希。浏览器 Cookie 只保存随机会话令牌，数据库只保存令牌的 SHA-256；Cookie 使用 `HttpOnly`、`SameSite=Lax`，HTTPS 下自动增加 `Secure`。
- 桌面端使用 `POST /api/auth/desktop/login` 签发独立的 Bearer 会话；令牌只能放在 `Authorization` 请求头中，不能放进 URL、Cookie 或日志。客户端启动时可通过 `POST /api/auth/desktop/refresh` 轮换令牌，并以 `POST /api/auth/desktop/logout` 撤销当前桌面会话。该会话沿用 `STOCK_ACCOUNT_SESSION_DAYS` 的有效期，服务端仍然只保存其 SHA-256 摘要。
- 网页自选工具栏提供“下载桌面端”链接，始终跳转到 GitHub 最新正式版；“画中画盯盘”在 Safari、Chrome、Edge 中均保持原生置顶画中画，旁边的“可拖动浮窗”则打开可自由摆放和缩放的独立盯盘窗口。

### 聊天室记录与加载规则

- 登录账号发送的文字和图片消息都会写入账号 MySQL 数据库的 `chat_messages` 表；服务重启或用户重新进入后仍可读取。
- 每次进入聊天室，默认只展示上海时区昨天 `00:00` 至当前的最近 20 条记录，不会直接展开全部历史；点击顶部提示或向上滚动后，才按游标继续加载更早记录，每页最多 50 条，单次页面最多展示 500 条。
- 关闭聊天室会清空当前页面中的聊天视图，但不会删除数据库记录；重新进入时会重新加载近期记录。最小化再恢复属于同一次进入。
- 浏览器单次最多渲染 500 条事件，并最多保留其中 50 张已解码图片；超过图片边界时只释放页面里的旧图片，数据库原记录仍保留，重新进入后可以再次查看。
- 支持 JPEG、PNG、GIF 和 WebP。单张最终图片不超过 768KB，普通图片可由浏览器自动压缩；原图上限 12MB，超限 GIF 不自动压缩。
- 可以点击图片按钮选择文件，也可以在聊天输入框直接粘贴剪贴板中的截图或图片。
- 图片以 Data URL 写入数据库并通过当前 SSE 连接广播；服务端会复核 MIME 类型、Base64 编码和文件签名。每个账号 1 分钟最多发送 3 张图片。图片记录增长较快，生产环境应按业务需要定期备份并监控数据库容量。
- 表情按钮使用内置 Unicode 表情，本质上仍是普通文字消息。
- 图片按钮使用内置 SVG 图标，不依赖设备的 Emoji 字体，所有浏览器显示一致。
- 管理员可在聊天室在线人数处查看当前在线账号；普通账号只能看到在线人数，不能读取在线账号列表。

### 管理员账号

- `users.is_admin=1` 表示管理员，默认注册账号均为 `0`；普通用户不能自行提权，只有已经登录的管理员可以通过受保护的管理接口修改其他账号的角色。
- 管理员的右上角账号菜单只保留“账户设置与密码”和退出登录；系统管理功能统一从侧边栏进入。
- 管理员可从侧边栏“系统管理”进入“用户与权限”，逐个授予或撤销其他账号的管理员角色，并授予或收回 AI 问股权限；管理员天然拥有问股权限。
- 管理员不能修改自己的管理员身份，系统也会拒绝撤销最后一名启用中管理员，避免管理入口被意外锁死。角色变化会立即作用于服务端权限判断；被调整账号刷新页面后即可看到新的管理界面。
- 管理员可从侧边栏“系统管理”进入“AI 问股管理”，配置页面公开状态、网站全局 OpenAI 兼容模型和使用看板；用户已启用个人模型时优先使用它，未配置个人模型的已获权限用户才使用网站模型。模型 API Key 只显示为输入框，保存后不回显。
- 管理员进入聊天室后，可以点击“在线人数”查看当前 Node.js 实例中的在线账号及连接数。
- 系统首次启用时还没有可操作管理页面的管理员，需要在数据库后台初始化第一个管理员；以下 SQL 也可用于紧急恢复：

```sql
UPDATE users SET is_admin=1 WHERE username='需要设为管理员的账号';
-- 如需取消管理员：
UPDATE users SET is_admin=0 WHERE username='需要取消管理员的账号';
```

### 主力资金历史数据

- 个股“主力资金”页只请求东方财富 `daykline`，统一展示其最近 120 个交易日的主力净流入、超大单净额和大单净额。新浪对大单/主力的分类口径不同，可能与东方财富出现相反方向，因此不再作为该指标的备用源。
- 当日交易中会额外读取东方财富实时资金字段，并按日期覆盖或补入当天柱体；日线历史和实时值均来自东方财富，属于同一口径。实时点不会写入历史缓存。
- 成功结果只以东方财富 `eastmoney-daykline` 来源、金额单位为元写入缓存，并保留 30 天。完整历史曲线的新鲜期为 15 分钟；到期后先立即展示最近 7 天内同一来源的正确缓存，并在后台刷新。此前保存的新浪缓存会自动忽略。
- 东方财富日线刷新按单队列执行，同一股票的请求会合并；失败后有一次延迟重试，且普通打开在 1 分钟内不会重复发起刷新，以降低上游限流风险。当天柱体仍独立读取东方财富实时字段，不受历史缓存新鲜期影响。
- 日线历史暂时不可用、但东方财富实时资金可用时，页面会明确提示“历史曲线暂时获取不到，当前仅显示今日实时资金”，并提供“重新获取历史”按钮。该按钮会绕过新鲜缓存主动请求东方财富日线；两者都不可用时才提示“主力资金数据暂时拿不到，请稍后重试”。
- “主力净流入”按东方财富口径展示；“近五日累计”为最近五个交易日主力净流入的滚动求和。

### 账号建表 SQL

下面是账号体系的完整建表语句；同一份 SQL 也保存在 `database/account_schema.sql`。生产环境建议先由数据库管理员执行。账号服务启动时也会运行相同的 `CREATE TABLE IF NOT EXISTS`，不会删除或覆盖已有数据。

```sql
USE stock;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NULL COMMENT '密码登录账号；纯微信账号可为空',
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'scrypt 加盐哈希；不保存明文密码',
  display_name VARCHAR(80) NOT NULL,
  avatar_url VARCHAR(500) NULL,
  custom_avatar_data MEDIUMTEXT NULL COMMENT '用户上传的头像 Data URL；最大 160KB',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  is_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=管理员；首次管理员需由数据库初始化，后续可由管理员授权',
  config_decided_at DATETIME NULL COMMENT '首次登录配置关联是否已选择',
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_status (status),
  KEY idx_users_admin_status (is_admin, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_auth_identities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_user_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  unionid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  profile_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_identity_provider_user (provider, provider_user_id),
  KEY idx_auth_identity_user (user_id),
  CONSTRAINT fk_auth_identity_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '只保存会话令牌 SHA-256',
  expires_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_sessions_token (token_hash),
  KEY idx_user_sessions_user (user_id),
  KEY idx_user_sessions_expires (expires_at),
  CONSTRAINT fk_user_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_page_preferences (
  user_id BIGINT UNSIGNED NOT NULL,
  config_json JSON NOT NULL,
  config_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_preferences_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_oauth_states (
  state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '微信 OAuth state 的 SHA-256',
  provider VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  return_to VARCHAR(500) NOT NULL DEFAULT '/',
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (state_hash),
  KEY idx_user_oauth_states_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS site_recommendations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  url VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_admin_only TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=仅管理员账号可见',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_site_recommendations_url (url),
  KEY idx_site_recommendations_active_sort (is_active, sort_order, id),
  KEY idx_site_recommendations_visibility_sort (is_active, is_admin_only, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_fund_flow_history_cache (
  symbol VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_json JSON NOT NULL COMMENT '东方财富 daykline 最近成功数据（金额单位：元）',
  source VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '固定为 eastmoney-daykline',
  fetched_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol),
  KEY idx_fund_flow_cache_source_fetched (source, fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  message_type VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  text_content VARCHAR(500) NULL,
  image_data MEDIUMTEXT NULL COMMENT '图片 Data URL；单张最终图片不超过 768KB',
  image_mime VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  display_name VARCHAR(80) NOT NULL COMMENT '发送时显示名称快照',
  avatar_url MEDIUMTEXT NULL COMMENT '发送时头像快照',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_chat_messages_created (created_at, id),
  KEY idx_chat_messages_user (user_id, id),
  CONSTRAINT fk_chat_messages_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_note_folders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_note_folders_name (user_id, name),
  KEY idx_user_note_folders_user (user_id),
  CONSTRAINT fk_user_note_folders_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  folder_id BIGINT UNSIGNED NULL,
  title VARCHAR(200) NOT NULL DEFAULT '',
  content MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_notes_user (user_id),
  KEY idx_user_notes_folder (user_id, folder_id),
  KEY idx_user_notes_updated (user_id, updated_at),
  CONSTRAINT fk_user_notes_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_notes_folder
    FOREIGN KEY (folder_id) REFERENCES user_note_folders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

已有 `users` 表的环境还需要执行以下管理员字段迁移；应用启动时会自动检测并尝试执行，但生产环境仍建议由数据库管理员预先完成：

```sql
ALTER TABLE users
  ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=管理员；首次管理员需由数据库初始化，后续可由管理员授权' AFTER status,
  ADD KEY idx_users_admin_status (is_admin, status);
```

已有账号和聊天记录表的环境还需要执行以下头像迁移。它保留原微信头像链接，新增单独的自定义头像字段，并将聊天记录中的头像快照扩容为 `MEDIUMTEXT`；应用启动时会自动检测并尝试执行，但生产环境请由数据库管理员预先完成：

```sql
ALTER TABLE users
  ADD COLUMN custom_avatar_data MEDIUMTEXT NULL AFTER avatar_url;

ALTER TABLE chat_messages
  MODIFY COLUMN avatar_url MEDIUMTEXT NULL;
```

已有 `site_recommendations` 表的环境还需要增加站点可见范围字段。现有记录会默认保持所有人可见；应用启动时会自动检测并尝试升级，生产环境也可预先执行：

```sql
ALTER TABLE site_recommendations
  ADD COLUMN is_admin_only TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active,
  ADD KEY idx_site_recommendations_visibility_sort (is_active, is_admin_only, sort_order, id);
```

已有 `user_notes` 表的环境，先执行上面的 `user_note_folders` 建表语句，再执行一次以下迁移；应用启动时会自动完成这两步检测与升级：

```sql
ALTER TABLE user_notes
  ADD COLUMN folder_id BIGINT UNSIGNED NULL AFTER user_id,
  ADD KEY idx_user_notes_folder (user_id, folder_id),
  ADD CONSTRAINT fk_user_notes_folder
    FOREIGN KEY (folder_id) REFERENCES user_note_folders(id) ON DELETE SET NULL;
```

### AI 问股附加建表 SQL

启用问股前，生产环境请由数据库管理员执行以下新增表；同一份完整定义也在 `database/account_schema.sql`。应用可自动执行 `CREATE TABLE IF NOT EXISTS`，但生产数据库若未向应用账号授予建表权限，应先手工执行。`ai_messages` 与 `ai_conversations` 只通过 `user_id` 关联查询，用户不能通过猜测会话 ID 读取其他账号历史。

```sql
CREATE TABLE IF NOT EXISTS ai_feature_settings (
  feature_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 0,
  updated_by_user_id BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (feature_key),
  CONSTRAINT fk_ai_feature_settings_user FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_user_permissions (
  user_id BIGINT UNSIGNED NOT NULL,
  feature_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  granted_by_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, feature_key),
  KEY idx_ai_user_permissions_feature_user (feature_key, user_id),
  CONSTRAINT fk_ai_user_permissions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_user_permissions_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_model_configs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  model_name VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_url VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'chat_completions',
  api_key_encrypted TEXT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_model_configs_active (is_active, id),
  CONSTRAINT fk_ai_model_configs_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_ai_model_configs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  model_name VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_url VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'chat_completions',
  api_key_encrypted TEXT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_ai_model_configs_user (user_id, is_active, id),
  CONSTRAINT fk_user_ai_model_configs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_conversations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(160) NOT NULL DEFAULT '新问股会话',
  summary MEDIUMTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ai_conversations_user_updated (user_id, updated_at, id),
  CONSTRAINT fk_ai_conversations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content MEDIUMTEXT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'complete',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ai_messages_conversation (conversation_id, id),
  CONSTRAINT fk_ai_messages_conversation FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message_id BIGINT UNSIGNED NULL,
  model_config_id BIGINT UNSIGNED NULL,
  user_model_config_id BIGINT UNSIGNED NULL,
  provider VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  model_name VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  total_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ai_usage_user_created (user_id, created_at),
  KEY idx_ai_usage_created (created_at),
  KEY idx_ai_usage_user_model (user_model_config_id),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_usage_conversation FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_usage_message FOREIGN KEY (message_id) REFERENCES ai_messages(id) ON DELETE SET NULL,
  CONSTRAINT fk_ai_usage_model FOREIGN KEY (model_config_id) REFERENCES ai_model_configs(id) ON DELETE SET NULL,
  CONSTRAINT fk_ai_usage_user_model FOREIGN KEY (user_model_config_id) REFERENCES user_ai_model_configs(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`ai_feature_settings.ai_chat.is_public=1` 表示向所有已登录用户公开问股入口；为 `0` 时，只有管理员和 `ai_user_permissions` 中 `feature_key='ai_chat'` 的已授权用户可使用问股。管理员在“用户与权限”页面操作单用户授权；未获问股权限的用户不会看到整个 AI 菜单。已授权用户启用个人模型时，问股入口会优先使用个人模型；没有个人模型时，才使用网站全局模型。问股对话区下方会列出当前可选的所有模型。`user_ai_model_configs` 始终按 `user_id` 查询和修改，不能通过猜测 ID 读取或修改其他用户的密钥配置。管理员可以删除全局模型；历史使用记录会保留模型名称等审计字段，并将全局模型外键置空。个人模型有历史使用记录后只能停用，不能删除，以保持使用看板的审计完整性。

已有 `ai_usage_records` 表的生产环境还需要让全局模型引用可空，并新增私有模型引用；应用启动时会尝试升级。若应用数据库账号没有 `ALTER` 权限，请由数据库管理员在确认列和约束尚不存在后执行：

```sql
ALTER TABLE ai_usage_records MODIFY COLUMN model_config_id BIGINT UNSIGNED NULL;
ALTER TABLE ai_usage_records DROP FOREIGN KEY fk_ai_usage_model;
ALTER TABLE ai_usage_records
  ADD CONSTRAINT fk_ai_usage_model
  FOREIGN KEY (model_config_id) REFERENCES ai_model_configs(id) ON DELETE SET NULL;
ALTER TABLE ai_usage_records ADD COLUMN user_model_config_id BIGINT UNSIGNED NULL AFTER model_config_id;
ALTER TABLE ai_usage_records ADD KEY idx_ai_usage_user_model (user_model_config_id);
ALTER TABLE ai_usage_records
  ADD CONSTRAINT fk_ai_usage_user_model
  FOREIGN KEY (user_model_config_id) REFERENCES user_ai_model_configs(id) ON DELETE RESTRICT;
```

### 启用 AI 问股与独立 Python 服务

问股由两个服务组成：Node 服务仍是浏览器唯一入口，负责登录态、权限、数据库会话历史和模型密钥加密；`stock-api-agent`（建议与本仓库同级部署）仅编排模型工具调用。Python 服务不对公网开放，建议绑定 `127.0.0.1:8001` 或受认证的私网。

Node `.env` 需要：

```env
STOCK_AI_ENABLED=true
STOCK_AI_AGENT_URL=http://127.0.0.1:8001
STOCK_AI_AGENT_INTERNAL_TOKEN=<与 Python 服务相同的长随机密钥>
# 必须是 32 字节随机数的 Base64，例如：openssl rand -base64 32
STOCK_AI_CREDENTIAL_ENCRYPTION_KEY=<Base64 密钥>
```

在 `stock-api-agent` 项目中复制 `.env.example` 为 `.env`，将 `AGENT_INTERNAL_TOKEN` 设成同一个值，并设置 `AGENT_NODE_BASE_URL=http://127.0.0.1:3000`。然后分别启动：

```bash
# Node 项目
./run.sh restart

# Python 项目（首次会创建 Conda Python 3.11 环境）
cd ../stock-api-agent
./scripts/run.sh install
./scripts/run.sh restart
./scripts/run.sh status
```

Python 服务会校验 Node 对每个请求生成的 HMAC 签名和时间戳；浏览器永远不会拿到已保存的模型 Key。管理员登录后可在“AI 问股管理”添加网站全局模型；获得问股权限的用户也可从侧边栏“AI / AI模型”保存自己的模型，个人模型会优先于网站模型。模型配置页可在填写 Base URL 和 API Key 后进行连接测试；问股页会以一个下拉框列出当前可用的个人模型或网站全局模型。连接测试通过 OpenAI 兼容接口的 `/models` 验证地址与权限，不记录 API Key，只接受 HTTPS 接口（本机兼容服务可使用 HTTP），并拒绝非本机的内网地址。首版支持 OpenAI 兼容 Chat Completions：例如 OpenAI 可填写 Base URL `https://api.openai.com/v1`、模型名和对应 API Key；其他兼容供应商也可按其兼容地址填写。问股工具只读取当前 Node 已提供的行情、指标、K 线和资金流接口，不执行任何交易。

文件夹按账号隔离，每个账号最多创建 50 个。删除文件夹只会解除分类并把其中笔记移到“未分类”，不会删除笔记内容。新建或导入前可在顶部选择目标文件夹；打开笔记后可通过“归类到”把未分类笔记移入文件夹。

站点推荐读取 `site_recommendations` 中 `is_active=1` 的记录，并按 `sort_order`、`id` 排序。用户点击侧边栏“站点推荐”后，会在右侧资源目录中浏览、搜索并在新标签页打开链接。`is_admin_only=1` 的记录只会返回给当前已登录的管理员，普通账号和游客无法通过接口读取；默认值 `0` 保证现有站点继续对所有人可见。新安装不会自动写入任何推荐站点，请由管理员在系统管理页面自行添加和维护。

账号服务需要数据库账号拥有 `SELECT`、`INSERT`、`UPDATE`、`DELETE` 权限。若让应用启动时自动建表和升级旧表，还需要 `CREATE`、`ALTER`、`INDEX`、`REFERENCES`：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON stock.*
  TO 'stock_wechat'@'<应用服务器私网IP>';
```

### 启用账号密码登录

账号体系复用下文的 `STOCK_DB_*` MySQL 连接配置。在 `.env` 中设置：

```env
STOCK_ACCOUNT_ENABLED=true
STOCK_ACCOUNT_DRIVER=mysql
STOCK_ACCOUNT_SESSION_DAYS=30

STOCK_DB_HOST=<数据库内网地址>
STOCK_DB_PORT=3306
STOCK_DB_USER=stock_wechat
STOCK_DB_PASSWORD='<随机强密码>'
STOCK_DB_NAME=stock
STOCK_DB_CONNECTION_LIMIT=5
```

本地临时体验可以使用 `STOCK_ACCOUNT_DRIVER=memory`，无需 MySQL，但所有账号、会话和配置会在 Node.js 重启后丢失。代码会拒绝在 `NODE_ENV=production` 时使用内存驱动。

### 启用微信扫码登录

微信扫码登录使用微信开放平台的“网站应用”，不是公众号网页授权。需要先在微信开放平台创建并审核通过网站应用、申请微信登录能力，并把回调域名配置为当前站点。官方流程采用 `scope=snsapi_login` 的 authorization code 模式，服务端会校验一次性 `state`、使用 `code` 换取身份并读取昵称和头像。

```env
STOCK_WECHAT_LOGIN_APP_ID=<网站应用AppID>
STOCK_WECHAT_LOGIN_APP_SECRET=<网站应用AppSecret>
STOCK_WECHAT_LOGIN_CALLBACK_URL=https://stock.sherlock-holmes.cn/api/auth/wechat/callback
```

注意：

- 回调地址必须使用 HTTPS，并与微信开放平台审核/配置的授权域名一致。
- `STOCK_WECHAT_LOGIN_APP_ID`、`STOCK_WECHAT_LOGIN_APP_SECRET` 与下文公众号消息推送的 AppID/AppSecret 是两套配置，不要混用。
- Nginx 必须保留 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto`，现有示例已包含必要的 `Host` 和 `X-Forwarded-Proto`；建议额外加入 `proxy_set_header X-Forwarded-Host $host;`。
- 官方接入说明：[网站应用微信登录开发指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)。

启用后重启并检查日志：

```bash
./run.sh restart
tail -f output.log
```

正常日志包含：

```text
Account service ready (mysql; WeChat login enabled)
```

微信公众号集成目标：

- 继续使用现有 Node.js 服务，不新增另一套系统。
- 使用普通公众号的文本客服消息接口，不使用模板消息。
- 自动记录关注用户的 OpenID 和提醒开关。
- 每周一 `09:00`（`Asia/Shanghai`）汇总并发送本周可申购新股。
- 点击文本中的链接进入 `https://stock.sherlock-holmes.cn/?page=ipo`。
- 使用 MySQL 保存关注者、任务和发送结果，防止重复发送。
- 通过内部管理接口创建公众号底部自定义菜单。
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

当前实现不会在服务器侧预先判断互动时间，而是在每周一发起调用，并将微信的真实返回结果写入数据库。若微信返回 `48001`，代码本身无法绕过微信账号权限，需要改用有权限的账号或改为公众平台后台人工群发。

- [发送客服消息官方文档](https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html)
- [根据 OpenID 群发消息官方文档](https://developers.weixin.qq.com/doc/service/api/notify/message/api_masssend.html)

## 2. 已经添加到项目的能力

项目增加了以下文件：

```text
.env.example                    环境变量示例
package.json                    项目依赖和检查命令
package-lock.json               依赖锁定文件
database/account_schema.sql     账号体系建表 SQL
database/wechat_schema.sql      微信推送建表 SQL
account/config.js               账号、会话、微信登录配置
account/security.js             密码哈希、令牌与页面配置白名单
account/database.js             MySQL/测试内存数据访问与自动建表
account/service.js              注册、登录、配置同步、站点推荐、笔记/文件夹和微信 OAuth 路由
chat/chat.js                    仅登录账号可用、支持持久化历史分页的 SSE 实时聊天室
fund-flow-history.js            东方财富主力资金历史数据解析
public/reference-reader.js      站内页和独立页共用的参考文档安全渲染器
wechat/config.js                配置读取和校验
wechat/client.js                access_token、客服消息和自定义菜单 API
wechat/database.js              MySQL 数据访问和自动建表
wechat/service.js               回调、内部接口、调度和发送流程
wechat/weekly-ipo.js            每周/每日日期筛选及打新汇总
wechat/xml.js                   微信 XML 消息解析和回复
test/wechat.test.js             核心逻辑测试
test/account.test.js            账号、配置、笔记/文件夹归属流程测试
test/chat.test.js               聊天登录、历史分页、图片安全、限流和连接测试
```

现有文件的调整：

- `server.js` 增加账号、聊天室和微信路由，并在服务启动后启动相关模块。
- `run.sh` 启动时自动读取项目 `.env`，不会修改系统全局环境变量。
- `public/index.html` 提供行情、打新、异动、账号笔记、站内参考文档和浮动聊天室界面；页面标签同步到 `?page=`，支持刷新、分享及浏览器前进/后退。
- `public/reference.html` 保留独立阅读模式，供用户从站内文档页选择“新窗口打开”。
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

每周一上海时间 09:00，或每天上海时间 09:00
              ↓
调用现有 loadIpoCalendar()
              ↓
筛选本周一至本周日，或等于当天的 applyDate
              ↓
生成一条文本汇总
              ↓
数据库 GET_LOCK 防止多实例并发
              ↓
创建 weekly-ipo:YYYY-MM-DD 或 daily-ipo:YYYY-MM-DD 唯一任务
              ↓
读取 subscribed=1 且 ipo_notify_enabled=1 的 OpenID
              ↓
逐个调用微信客服文本消息接口
              ↓
记录 sent 或 failed 及微信错误码
```

即使服务在计划时间没有运行，只要 `STOCK_WECHAT_SCHEDULE_CATCHUP=true`，当天稍后恢复运行时仍会补执行。数据库任务唯一键保证同一周的周报、同一天的当日提醒都不会成功发送两次。

如果本周没有新股，系统仍会发送：

```text
本周暂无可申购新股。
```

每日任务仅在当天存在可申购新股时创建并发送；当天没有新股时不会发送空提醒。

## 4. 第一步：保护和轮换敏感凭证

上线前必须妥善管理敏感凭证：

1. AppSecret 或数据库密码曾经泄漏时，先在对应平台完成轮换。
2. 为本应用创建专用数据库账号，不让 Node.js 长期使用 root。
3. 凭证只写入云服务器 `.env`，不要写入源码、README 或日志。
4. 将 `.env` 权限设置为 `600`，并确认它已被 `.gitignore` 排除。

代码和本文档不保存真实 AppSecret、管理密钥或数据库密码。

## 5. 第二步：准备 MySQL

数据库连接信息通过 `.env` 配置，推荐让应用服务器和数据库处于可互通的同一 VPC，并优先使用私网地址：

```text
地址：<数据库内网地址>:3306
数据库名：stock
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

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES
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
  ipo_notify_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否接收打新提醒',
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
STOCK_NODE_BIN=/root/miniconda3/bin/node
STOCK_NPM_BIN=/root/miniconda3/bin/npm

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
STOCK_WECHAT_DAILY_IPO_ENABLED=true
STOCK_WECHAT_DAILY_IPO_HOUR=9
STOCK_WECHAT_DAILY_IPO_MINUTE=0

STOCK_DB_HOST=填写数据库主机名或IP，不要附带端口
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

服务器存在多个 Node.js 时，先在 `.env` 中固定已经验证可运行的 Node 和 npm。例如当前服务器使用：

```env
STOCK_NODE_BIN=/root/miniconda3/bin/node
STOCK_NPM_BIN=/root/miniconda3/bin/npm
```

在项目目录执行：

```bash
./run.sh install
```

`run.sh install` 会使用与 `STOCK_NODE_BIN` 匹配的 npm 执行 `npm ci --omit=dev`。当前新增的运行依赖只有 MySQL 驱动 `mysql2`。

安装后检查：

```bash
./run.sh verify
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
打新 / 开启打新      开启打新提醒
取消打新 / 关闭打新  关闭打新提醒
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
        proxy_set_header X-Forwarded-Host $host;
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

`run.sh` 会在自己的进程中读取 `.env`，优先使用 `STOCK_NODE_BIN`，其次使用当前 Conda 环境的 Node。它不会依赖 PATH 中可能不兼容的旧 Node，也不会修改系统全局环境变量。

当前服务器推荐配置：

```env
STOCK_NODE_BIN=/root/miniconda3/bin/node
STOCK_NPM_BIN=/root/miniconda3/bin/npm
```

变量只会传给本次启动的 Node.js 进程。因为 `.env` 按 shell 配置读取，如果密码包含空格、`#`、`$` 等 shell 特殊字符，需要使用单引号包裹，例如 `STOCK_DB_PASSWORD='实际密码'`。

正常日志应包含：

```text
Stock monitor running at http://localhost:3000
WeChat IPO notification ready (Asia/Shanghai, weekly weekday=1 09:00; daily IPO 09:00)
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

### 12.2 创建或更新公众号菜单

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  https://stock.sherlock-holmes.cn/internal/wechat/menu/sync
```

成功时返回 `created=true`、提交的菜单结构以及微信的 `errcode=0`。该操作会覆盖公众号当前已有的自定义菜单，只在首次创建或需要更新菜单时调用，不需要每次启动服务都执行。

系统创建以下菜单：

```text
打新服务
├── 本周打新：立即被动回复本周打新信息
├── 开启提醒：打开数据库中的打新提醒开关
└── 关闭提醒：关闭数据库中的打新提醒开关

打新日历：打开 https://stock.sherlock-holmes.cn/?page=ipo
```

菜单创建后可能需要约 5 分钟才在微信客户端刷新。可以退出公众号会话后重新进入；测试阶段也可以取消关注后重新关注。

如果返回 `48001`，表示当前公众号没有自定义菜单 API 权限，需要在微信开发者平台“接口管理”中确认权限，或改用公众平台提供的菜单配置页面。

### 12.3 只预览、不发送

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

### 12.4 手动执行本周推送

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  https://stock.sherlock-holmes.cn/internal/wechat/ipo/run
```

同一周任务已经成功完成时，再次调用不会重复发送。

### 12.5 重试本周失败用户

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  'https://stock.sherlock-holmes.cn/internal/wechat/ipo/run?retry_failed=1'
```

只有确认失败原因已经排除后才应执行重试。

### 12.6 预览或执行当日推送

预览当天内容，不创建任务、不调用微信发送接口：

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  'https://stock.sherlock-holmes.cn/internal/wechat/ipo/daily/run?dry_run=1'
```

手动执行当天推送：

```bash
curl -X POST \
  -H 'X-Admin-Key: <管理密钥>' \
  https://stock.sherlock-holmes.cn/internal/wechat/ipo/daily/run
```

当天无可申购新股时返回 `accepted=false`，不会创建任务；当天任务已经完成时不会重复发送。失败用户可在确认故障排除后增加 `?retry_failed=1` 重试。

## 13. 定时规则

默认配置：

```text
时区：Asia/Shanghai
每周汇总：星期 1（周一）09:00
当日提醒：每天 09:00，且仅在当天有可申购新股时发送
补执行：开启
```

调度器每 30 秒检查一次时间。到达计划时间且有对应内容后，数据库使用以下任务键：

```text
weekly-ipo:本周一日期
daily-ipo:当天日期
```

例如：

```text
weekly-ipo:2026-07-27
daily-ipo:2026-07-30
```

该字段具有唯一索引。单进程重启、补执行和多实例同时运行都不会创建第二个相同任务；MySQL `GET_LOCK` 还会阻止多实例同时发送。可通过 `STOCK_WECHAT_DAILY_IPO_ENABLED=false` 单独关闭当日提醒，并用 `STOCK_WECHAT_DAILY_IPO_HOUR`、`STOCK_WECHAT_DAILY_IPO_MINUTE` 调整发送时间。

## 14. 消息内容示例

```text
【本周新股申购】
2026-07-27 至 2026-08-02

共 2 只：
1. 测试股份（787001）【科创板】
   2026-07-28 周二｜发行价 12.50元
2. 示例科技（301002）【创业板】
   2026-07-30 周四｜发行价 待公布

详情：https://stock.sherlock-holmes.cn/?page=ipo
数据以交易所最终公告为准，不构成投资建议。
```

最多列出 20 只，文本总长度限制在约 1900 字符内，避免超过微信文本消息长度限制。

当日提醒格式为 `【今日新股申购提醒】`，只列出 `applyDate` 等于当天的股票；其余字段和长度限制与周报一致。

## 15. 数据库状态说明

### 15.1 `wechat_subscribers`

保存：

- 用户 OpenID。
- 是否仍关注公众号。
- 是否开启打新提醒。
- OpenID 来源。
- 最近互动时间。

### 15.2 `wechat_push_jobs`

每周汇总最多一条任务，每日提醒最多一条任务。每日任务的 `week_start` 和 `week_end` 都保存当天日期。状态包括：

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

1. 确认 AppSecret 和数据库凭证未泄漏；如泄漏则先完成轮换。
2. 创建 `stock_wechat` 数据库账号。
3. 执行建表 SQL。
4. 在云服务器创建权限为 `600` 的 `.env`。
5. 执行 `./run.sh install` 和 `./run.sh verify`。
6. 先保持 `STOCK_WECHAT_ENABLED=false`，确认原股票服务正常。
7. 改为 `true` 并执行 `./run.sh restart`。
8. 调用 `/internal/wechat/status` 确认 `ready=true`。
9. 在微信开发者平台配置 API IP 白名单。
10. 配置明文消息回调 URL 和 Token。
11. 重新关注公众号或向公众号发送消息。
12. 检查 `wechat_subscribers` 是否出现 OpenID。
13. 调用 `/internal/wechat/menu/sync` 创建公众号底部菜单。
14. 调用 `dry_run=1` 检查本周数据和文本内容。
15. 手动执行一次本周推送。
16. 检查 `wechat_push_deliveries` 的微信错误码。
17. 若返回 `errcode=0`，再等待下一个周一自动执行。

## 18. 安全要求

- 不要把 `.env`、AppSecret、管理密钥或数据库密码提交到 Git。
- 不要通过网页 JavaScript 读取这些值。
- 不要在日志中打印 access_token、AppSecret 或数据库密码。
- 内部管理接口必须保留强随机 `STOCK_WECHAT_ADMIN_KEY`。
- MySQL 只允许应用服务器私网 IP 访问。
- Node.js 使用专用低权限数据库账号，禁止使用 root 长期运行。
- 定期检查 `wechat_push_deliveries` 中的异常错误码。
- AppSecret 或数据库密码泄漏后立即轮换，而不是只删除暴露记录。

## 19. 当前实现范围

当前已经实现：

- 明文微信回调验证。
- 关注、取消关注、文本消息和菜单事件处理。
- OpenID 与提醒状态持久化。
- access_token 缓存和失效刷新。
- 客服文本消息发送。
- 每周及当日 IPO 计算和消息生成。
- 每周一汇总、每日有股提醒及当天补执行。
- MySQL 分布式锁和唯一键防重。
- 逐用户发送结果和错误码记录。
- 手动预览、执行、失败重试和用户同步接口。
- 自定义菜单创建接口，以及本周打新、开启提醒、关闭提醒菜单事件。
- `?page=ipo` 页面直达。

当前没有实现：

- 模板消息。
- 安全模式回调的 AES 加解密。
- 绕过微信对普通订阅号的 API 权限限制。
- 绕过微信对客服消息发送时机的限制。
- 微信公众平台后台群发的自动化操作。

最后三项属于微信平台规则或后台能力，无法仅通过服务器代码规避。
