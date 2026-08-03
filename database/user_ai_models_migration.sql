-- Migration: Add user-level AI model configurations
-- This allows users to configure their own AI models if admin hasn't configured global models

USE stock;

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
  CONSTRAINT fk_user_ai_model_configs_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Existing installations with ai_usage_records need these once. Check the
-- information_schema first when rerunning this migration, because MySQL does
-- not support IF NOT EXISTS for all ALTER TABLE clauses on older versions.
ALTER TABLE ai_usage_records MODIFY COLUMN model_config_id BIGINT UNSIGNED NULL;
ALTER TABLE ai_usage_records ADD COLUMN user_model_config_id BIGINT UNSIGNED NULL AFTER model_config_id;
ALTER TABLE ai_usage_records ADD KEY idx_ai_usage_user_model (user_model_config_id);
ALTER TABLE ai_usage_records
  ADD CONSTRAINT fk_ai_usage_user_model
  FOREIGN KEY (user_model_config_id) REFERENCES user_ai_model_configs(id) ON DELETE RESTRICT;
