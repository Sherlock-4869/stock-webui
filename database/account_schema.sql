-- 在 stock 数据库中执行。应用启动时也会以 CREATE TABLE IF NOT EXISTS 自动检查这些表。
USE stock;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NULL COMMENT '密码登录账号；纯微信账号可为空',
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'scrypt 加盐哈希；不保存明文密码',
  display_name VARCHAR(80) NOT NULL,
  avatar_url VARCHAR(500) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  config_decided_at DATETIME NULL COMMENT '首次登录配置关联是否已选择',
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_status (status)
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
