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
