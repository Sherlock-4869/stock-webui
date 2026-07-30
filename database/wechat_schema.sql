-- 在 stock 数据库中执行。应用启动时也会以 CREATE TABLE IF NOT EXISTS 自动检查这些表。
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
