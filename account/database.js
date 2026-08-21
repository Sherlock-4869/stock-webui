'use strict';

const mysql = require('mysql2/promise');

const FUND_FLOW_HISTORY_CACHE_RETENTION_DAYS = 30;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
    password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
    display_name VARCHAR(80) NOT NULL,
    avatar_url VARCHAR(500) NULL,
    custom_avatar_data MEDIUMTEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=管理员；首次管理员需由数据库初始化，后续可由管理员授权',
    config_decided_at DATETIME NULL,
    last_login_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_users_username (username),
    KEY idx_users_status (status),
    KEY idx_users_admin_status (is_admin, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_auth_identities (
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
    CONSTRAINT fk_auth_identity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_sessions_token (token_hash),
    KEY idx_user_sessions_user (user_id),
    KEY idx_user_sessions_expires (expires_at),
    CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_page_preferences (
    user_id BIGINT UNSIGNED NOT NULL,
    config_json JSON NOT NULL,
    config_version INT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_user_preferences_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_oauth_states (
    state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    return_to VARCHAR(500) NOT NULL DEFAULT '/',
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (state_hash),
    KEY idx_user_oauth_states_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS site_recommendations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    url VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    is_admin_only TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_site_recommendations_url (url),
    KEY idx_site_recommendations_active_sort (is_active, sort_order, id),
    KEY idx_site_recommendations_visibility_sort (is_active, is_admin_only, sort_order, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS reference_documents (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    title VARCHAR(200) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    content MEDIUMTEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by_user_id BIGINT UNSIGNED NULL,
    updated_by_user_id BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_reference_documents_visibility_sort (is_active, sort_order, id),
    CONSTRAINT fk_reference_documents_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_reference_documents_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS stock_fund_flow_history_cache (
    symbol VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    data_json JSON NOT NULL,
    source VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    fetched_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol),
    KEY idx_fund_flow_cache_source_fetched (source, fetched_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    message_type VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    text_content VARCHAR(500) NULL,
    image_data MEDIUMTEXT NULL,
    image_mime VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
    display_name VARCHAR(80) NOT NULL,
    avatar_url MEDIUMTEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_chat_messages_created (created_at, id),
    KEY idx_chat_messages_user (user_id, id),
    CONSTRAINT fk_chat_messages_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_note_folders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(80) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_note_folders_name (user_id, name),
    KEY idx_user_note_folders_user (user_id),
    CONSTRAINT fk_user_note_folders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_notes (
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
    CONSTRAINT fk_user_notes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_notes_folder FOREIGN KEY (folder_id) REFERENCES user_note_folders(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ai_feature_settings (
    feature_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    is_public TINYINT(1) NOT NULL DEFAULT 0,
    updated_by_user_id BIGINT UNSIGNED NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (feature_key),
    CONSTRAINT fk_ai_feature_settings_user FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ai_user_permissions (
    user_id BIGINT UNSIGNED NOT NULL,
    feature_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    granted_by_user_id BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, feature_key),
    KEY idx_ai_user_permissions_feature_user (feature_key, user_id),
    CONSTRAINT fk_ai_user_permissions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_ai_user_permissions_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ai_model_configs (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_ai_model_configs (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ai_conversations (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(160) NOT NULL DEFAULT '新问股会话',
    summary MEDIUMTEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_ai_conversations_user_updated (user_id, updated_at, id),
    CONSTRAINT fk_ai_conversations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ai_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    content MEDIUMTEXT NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'complete',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_ai_messages_conversation (conversation_id, id),
    CONSTRAINT fk_ai_messages_conversation FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ai_usage_records (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function ensureAdminSchema(connection, databaseName) {
  const [columns] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME='is_admin' LIMIT 1`,
    [databaseName]
  );
  if (!columns.length) {
    await connection.query("ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=管理员；首次管理员需由数据库初始化，后续可由管理员授权' AFTER status");
  }

  const [indexes] = await connection.execute(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND INDEX_NAME='idx_users_admin_status' LIMIT 1`,
    [databaseName]
  );
  if (!indexes.length) {
    await connection.query('ALTER TABLE users ADD KEY idx_users_admin_status (is_admin, status)');
  }
}

async function ensureSiteRecommendationVisibilitySchema(connection, databaseName) {
  const [columns] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='site_recommendations' AND COLUMN_NAME='is_admin_only' LIMIT 1`,
    [databaseName]
  );
  if (!columns.length) {
    await connection.query(
      'ALTER TABLE site_recommendations ADD COLUMN is_admin_only TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active'
    );
  }

  const [indexes] = await connection.execute(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='site_recommendations' AND INDEX_NAME='idx_site_recommendations_visibility_sort' LIMIT 1`,
    [databaseName]
  );
  if (!indexes.length) {
    await connection.query(
      'ALTER TABLE site_recommendations ADD KEY idx_site_recommendations_visibility_sort (is_active, is_admin_only, sort_order, id)'
    );
  }
}

async function ensureNoteFolderSchema(connection, databaseName) {
  const [columns] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='user_notes' AND COLUMN_NAME='folder_id' LIMIT 1`,
    [databaseName]
  );
  if (!columns.length) {
    await connection.query('ALTER TABLE user_notes ADD COLUMN folder_id BIGINT UNSIGNED NULL AFTER user_id');
  }

  const [indexes] = await connection.execute(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='user_notes' AND INDEX_NAME='idx_user_notes_folder' LIMIT 1`,
    [databaseName]
  );
  if (!indexes.length) {
    await connection.query('ALTER TABLE user_notes ADD KEY idx_user_notes_folder (user_id, folder_id)');
  }

  const [constraints] = await connection.execute(
    `SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='user_notes' AND CONSTRAINT_NAME='fk_user_notes_folder' LIMIT 1`,
    [databaseName]
  );
  if (!constraints.length) {
    await connection.query(
      'ALTER TABLE user_notes ADD CONSTRAINT fk_user_notes_folder FOREIGN KEY (folder_id) REFERENCES user_note_folders(id) ON DELETE SET NULL'
    );
  }
}

async function ensureAvatarSchema(connection, databaseName) {
  const [userColumns] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME='custom_avatar_data' LIMIT 1`,
    [databaseName]
  );
  if (!userColumns.length) {
    await connection.query('ALTER TABLE users ADD COLUMN custom_avatar_data MEDIUMTEXT NULL AFTER avatar_url');
  }

  const [chatColumns] = await connection.execute(
    `SELECT DATA_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='chat_messages' AND COLUMN_NAME='avatar_url' LIMIT 1`,
    [databaseName]
  );
  if (chatColumns.length && String(chatColumns[0].DATA_TYPE || '').toLowerCase() !== 'mediumtext') {
    await connection.query('ALTER TABLE chat_messages MODIFY COLUMN avatar_url MEDIUMTEXT NULL');
  }
}

async function ensureUserAiModelSchema(connection, databaseName) {
  const [modelColumn] = await connection.execute(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='ai_usage_records' AND COLUMN_NAME='model_config_id' LIMIT 1`,
    [databaseName]
  );
  if (modelColumn.length && String(modelColumn[0].IS_NULLABLE).toUpperCase() !== 'YES') {
    await connection.query('ALTER TABLE ai_usage_records MODIFY COLUMN model_config_id BIGINT UNSIGNED NULL');
  }

  const [userModelColumn] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='ai_usage_records' AND COLUMN_NAME='user_model_config_id' LIMIT 1`,
    [databaseName]
  );
  if (!userModelColumn.length) {
    await connection.query('ALTER TABLE ai_usage_records ADD COLUMN user_model_config_id BIGINT UNSIGNED NULL AFTER model_config_id');
  }

  const [globalModelConstraints] = await connection.execute(
    `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='ai_usage_records' AND CONSTRAINT_NAME='fk_ai_usage_model' LIMIT 1`,
    [databaseName]
  );
  if (globalModelConstraints.length && String(globalModelConstraints[0].DELETE_RULE).toUpperCase() !== 'SET NULL') {
    await connection.query('ALTER TABLE ai_usage_records DROP FOREIGN KEY fk_ai_usage_model');
  }
  if (!globalModelConstraints.length || String(globalModelConstraints[0].DELETE_RULE).toUpperCase() !== 'SET NULL') {
    await connection.query(
      'ALTER TABLE ai_usage_records ADD CONSTRAINT fk_ai_usage_model FOREIGN KEY (model_config_id) REFERENCES ai_model_configs(id) ON DELETE SET NULL'
    );
  }

  const [indexes] = await connection.execute(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='ai_usage_records' AND INDEX_NAME='idx_ai_usage_user_model' LIMIT 1`,
    [databaseName]
  );
  if (!indexes.length) {
    await connection.query('ALTER TABLE ai_usage_records ADD KEY idx_ai_usage_user_model (user_model_config_id)');
  }

  const [constraints] = await connection.execute(
    `SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='ai_usage_records' AND CONSTRAINT_NAME='fk_ai_usage_user_model' LIMIT 1`,
    [databaseName]
  );
  if (!constraints.length) {
    await connection.query(
      'ALTER TABLE ai_usage_records ADD CONSTRAINT fk_ai_usage_user_model FOREIGN KEY (user_model_config_id) REFERENCES user_ai_model_configs(id) ON DELETE RESTRICT'
    );
  }
}

function parseJson(value) {
  if (value == null || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function parseShanghaiDateTime(value) {
  if (value instanceof Date) return value;
  const normalized = String(value || '').trim().replace(' ', 'T');
  if (!normalized) return new Date(Number.NaN);
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}+08:00`);
}

class AccountDatabase {
  constructor(config) {
    this.config = config;
    this.pool = null;
  }

  async initialize() {
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit,
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: '+08:00',
    });
    const connection = await this.pool.getConnection();
    try {
      for (const statement of SCHEMA_STATEMENTS) await connection.query(statement);
      await ensureAdminSchema(connection, this.config.database);
      await ensureSiteRecommendationVisibilitySchema(connection, this.config.database);
      await ensureNoteFolderSchema(connection, this.config.database);
      await ensureAvatarSchema(connection, this.config.database);
      await ensureUserAiModelSchema(connection, this.config.database);
    } finally {
      connection.release();
    }
  }

  requirePool() {
    if (!this.pool) throw new Error('Account database is not initialized');
    return this.pool;
  }

  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }

  async listSiteRecommendations({ includeAdminOnly = false } = {}) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, name, url, description, is_admin_only
       FROM site_recommendations
       WHERE is_active=1 AND (is_admin_only=0 OR ?=1)
       ORDER BY sort_order ASC, id ASC
       LIMIT 50`,
      [includeAdminOnly ? 1 : 0]
    );
    return rows;
  }

  async listAllSiteRecommendations() {
    const [rows] = await this.requirePool().execute(
      `SELECT id, name, url, description, sort_order, is_active, is_admin_only, created_at, updated_at
       FROM site_recommendations ORDER BY sort_order ASC, id ASC LIMIT 200`
    );
    return rows;
  }

  async listReferenceDocuments({ includeInactive = false, includeContent = false } = {}) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, title, description, ${includeContent ? 'content,' : ''} sort_order, is_active, created_by_user_id, updated_by_user_id, created_at, updated_at
       FROM reference_documents
       WHERE (?=1 OR is_active=1)
       ORDER BY sort_order ASC, id ASC LIMIT 200`,
      [includeInactive ? 1 : 0]
    );
    return rows;
  }

  async getReferenceDocument(id, { includeInactive = false } = {}) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, title, description, content, sort_order, is_active, created_by_user_id, updated_by_user_id, created_at, updated_at
       FROM reference_documents WHERE id=? AND (?=1 OR is_active=1) LIMIT 1`,
      [id, includeInactive ? 1 : 0]
    );
    return rows[0] || null;
  }

  async createReferenceDocument({ title, description, content, sortOrder, isActive, userId }) {
    const [result] = await this.requirePool().execute(
      `INSERT INTO reference_documents (title, description, content, sort_order, is_active, created_by_user_id, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [title, description, content, sortOrder, isActive ? 1 : 0, userId, userId]
    );
    return this.getReferenceDocument(result.insertId, { includeInactive:true });
  }

  async updateReferenceDocument(id, { title, description, content, sortOrder, isActive, userId }) {
    const [result] = await this.requirePool().execute(
      `UPDATE reference_documents
       SET title=?, description=?, content=?, sort_order=?, is_active=?, updated_by_user_id=? WHERE id=?`,
      [title, description, content, sortOrder, isActive ? 1 : 0, userId, id]
    );
    return result.affectedRows ? this.getReferenceDocument(id, { includeInactive:true }) : null;
  }

  async deleteReferenceDocument(id) {
    const [result] = await this.requirePool().execute('DELETE FROM reference_documents WHERE id=?', [id]);
    return result.affectedRows > 0;
  }

  async seedReferenceDocument({ title, description = '', content, sortOrder = 0 }) {
    const [rows] = await this.requirePool().execute('SELECT id FROM reference_documents LIMIT 1');
    if (rows.length) return false;
    await this.requirePool().execute(
      `INSERT INTO reference_documents (title, description, content, sort_order, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [title, description, content, sortOrder]
    );
    return true;
  }

  async createSiteRecommendation({ name, url, description, sortOrder, isActive, isAdminOnly }) {
    const [result] = await this.requirePool().execute(
      `INSERT INTO site_recommendations (name, url, description, sort_order, is_active, is_admin_only)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, url, description, sortOrder, isActive ? 1 : 0, isAdminOnly ? 1 : 0]
    );
    return this.getSiteRecommendation(result.insertId);
  }

  async getSiteRecommendation(id) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, name, url, description, sort_order, is_active, is_admin_only, created_at, updated_at
       FROM site_recommendations WHERE id=? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async updateSiteRecommendation(id, { name, url, description, sortOrder, isActive, isAdminOnly }) {
    const [result] = await this.requirePool().execute(
      `UPDATE site_recommendations
       SET name=?, url=?, description=?, sort_order=?, is_active=?, is_admin_only=? WHERE id=?`,
      [name, url, description, sortOrder, isActive ? 1 : 0, isAdminOnly ? 1 : 0, id]
    );
    return result.affectedRows ? this.getSiteRecommendation(id) : null;
  }

  async deleteSiteRecommendation(id) {
    const [result] = await this.requirePool().execute(
      'DELETE FROM site_recommendations WHERE id=?',
      [id]
    );
    return result.affectedRows > 0;
  }

  async getFundFlowHistoryCache(symbol) {
    const [rows] = await this.requirePool().execute(
      `SELECT data_json, source, fetched_at
       FROM stock_fund_flow_history_cache WHERE symbol=? LIMIT 1`,
      [symbol]
    );
    if (!rows[0]) return null;
    return { data:parseJson(rows[0].data_json), source:rows[0].source, fetchedAt:rows[0].fetched_at };
  }

  async saveFundFlowHistoryCache(symbol, { data, source, fetchedAt }) {
    await this.requirePool().execute(
      `INSERT INTO stock_fund_flow_history_cache (symbol, data_json, source, fetched_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data_json=VALUES(data_json), source=VALUES(source), fetched_at=VALUES(fetched_at)`,
      [symbol, JSON.stringify(data), source, fetchedAt]
    );
  }

  async createChatMessage(userId, message) {
    const [result] = await this.requirePool().execute(
      `INSERT INTO chat_messages
        (user_id, message_type, text_content, image_data, image_mime, display_name, avatar_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        message.type,
        message.text || null,
        message.imageData || null,
        message.imageMime || null,
        message.displayName,
        message.avatarUrl || null,
        new Date(message.time),
      ]
    );
    const [rows] = await this.requirePool().execute(
      `SELECT id, user_id, message_type, text_content, image_data, image_mime,
              display_name, avatar_url, created_at
       FROM chat_messages WHERE id=? LIMIT 1`,
      [result.insertId]
    );
    return rows[0] || null;
  }

  async listChatMessages({ beforeId = null, since = null, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const fetchLimit = safeLimit + 1;
    let rows;
    if (beforeId) {
      [rows] = await this.requirePool().execute(
        `SELECT id, user_id, message_type, text_content, image_data, image_mime,
                display_name, avatar_url, created_at
         FROM chat_messages WHERE id<? ORDER BY id DESC LIMIT ${fetchLimit}`,
        [beforeId]
      );
    } else {
      [rows] = await this.requirePool().execute(
        `SELECT id, user_id, message_type, text_content, image_data, image_mime,
                display_name, avatar_url, created_at
         FROM chat_messages WHERE created_at>=? ORDER BY id DESC LIMIT ${fetchLimit}`,
        [since]
      );
    }

    let hasMore = rows.length > safeLimit;
    rows = rows.slice(0, safeLimit);
    let nextCursor = rows.length ? String(rows[rows.length - 1].id) : null;
    if (!beforeId && !hasMore) {
      const [older] = nextCursor
        ? await this.requirePool().execute('SELECT id FROM chat_messages WHERE id<? ORDER BY id DESC LIMIT 1', [nextCursor])
        : await this.requirePool().execute('SELECT id FROM chat_messages WHERE created_at<? ORDER BY id DESC LIMIT 1', [since]);
      if (older.length) {
        hasMore = true;
        if (!nextCursor) nextCursor = String(BigInt(String(older[0].id)) + 1n);
      }
    }
    return { messages:rows.reverse(), nextCursor:hasMore ? nextCursor : null, hasMore };
  }

  async createPasswordUser({ username, passwordHash, displayName }) {
    const [result] = await this.requirePool().execute(
      'INSERT INTO users (username, password_hash, display_name, last_login_at) VALUES (?, ?, ?, NOW())',
      [username, passwordHash, displayName]
    );
    return this.findUserById(result.insertId);
  }

  async findUserById(id) {
    const [rows] = await this.requirePool().execute('SELECT * FROM users WHERE id=? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findUserByUsername(username) {
    const [rows] = await this.requirePool().execute('SELECT * FROM users WHERE username=? LIMIT 1', [username]);
    return rows[0] || null;
  }

  async setUserAdmin({ userId, isAdmin }) {
    const connection = await this.requirePool().getConnection();
    try {
      await connection.beginTransaction();
      let activeAdmins = null;
      if (!isAdmin) {
        [activeAdmins] = await connection.execute(
          "SELECT id FROM users WHERE status='active' AND is_admin=1 ORDER BY id FOR UPDATE"
        );
      }
      const [rows] = await connection.execute(
        "SELECT id, status, is_admin FROM users WHERE id=? AND status='active' LIMIT 1 FOR UPDATE",
        [userId]
      );
      const user = rows[0];
      if (!user) {
        await connection.rollback();
        return null;
      }
      if (!isAdmin && Number(user.is_admin) === 1 && activeAdmins.length <= 1) {
        throw Object.assign(new Error('At least one active administrator is required'), { code:'LAST_ACTIVE_ADMIN' });
      }
      await connection.execute('UPDATE users SET is_admin=? WHERE id=?', [isAdmin ? 1 : 0, userId]);
      await connection.commit();
      return this.findUserById(userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateLastLogin(userId) {
    await this.requirePool().execute('UPDATE users SET last_login_at=NOW() WHERE id=?', [userId]);
  }

  async updateAvatar(userId, avatarData) {
    await this.requirePool().execute(
      'UPDATE users SET custom_avatar_data=? WHERE id=?',
      [avatarData || null, userId]
    );
    return this.findUserById(userId);
  }

  async updateProfile(userId, { displayName }) {
    await this.requirePool().execute('UPDATE users SET display_name=? WHERE id=?', [displayName, userId]);
    return this.findUserById(userId);
  }

  async upsertWechatUser({ providerUserId, openid, unionid, displayName, avatarUrl, profile }) {
    const connection = await this.requirePool().getConnection();
    try {
      await connection.beginTransaction();
      const [identities] = await connection.execute(
        'SELECT user_id FROM user_auth_identities WHERE provider=\'wechat\' AND provider_user_id=? FOR UPDATE',
        [providerUserId]
      );
      let userId = identities[0]?.user_id;
      if (userId) {
        await connection.execute(
          `UPDATE users SET avatar_url=?, last_login_at=NOW() WHERE id=?`,
          [avatarUrl || null, userId]
        );
        await connection.execute(
          `UPDATE user_auth_identities SET openid=?, unionid=?, profile_json=?
           WHERE provider='wechat' AND provider_user_id=?`,
          [openid || null, unionid || null, JSON.stringify(profile || {}), providerUserId]
        );
      } else {
        const [result] = await connection.execute(
          'INSERT INTO users (display_name, avatar_url, last_login_at) VALUES (?, ?, NOW())',
          [displayName, avatarUrl || null]
        );
        userId = result.insertId;
        await connection.execute(
          `INSERT INTO user_auth_identities
            (user_id, provider, provider_user_id, openid, unionid, profile_json)
           VALUES (?, 'wechat', ?, ?, ?, ?)`,
          [userId, providerUserId, openid || null, unionid || null, JSON.stringify(profile || {})]
        );
      }
      await connection.commit();
      return this.findUserById(userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createSession({ userId, tokenHash, expiresAt }) {
    await this.requirePool().execute(
      'INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [userId, tokenHash, expiresAt]
    );
  }

  async findSession(tokenHash) {
    const [rows] = await this.requirePool().execute(
      `SELECT s.id AS session_id, s.expires_at AS session_expires_at, s.last_seen_at, u.*
       FROM user_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=? AND s.expires_at>NOW() AND u.status='active' LIMIT 1`,
      [tokenHash]
    );
    return rows[0] || null;
  }

  async touchSession(sessionId) {
    await this.requirePool().execute(
      'UPDATE user_sessions SET last_seen_at=NOW() WHERE id=? AND last_seen_at<DATE_SUB(NOW(), INTERVAL 5 MINUTE)',
      [sessionId]
    );
  }

  async deleteSession(tokenHash) {
    await this.requirePool().execute('DELETE FROM user_sessions WHERE token_hash=?', [tokenHash]);
  }

  async getPreferences(userId) {
    const [rows] = await this.requirePool().execute(
      'SELECT config_json FROM user_page_preferences WHERE user_id=?',
      [userId]
    );
    return rows[0] ? parseJson(rows[0].config_json) : null;
  }

  async savePreferences(userId, config) {
    await this.requirePool().execute(
      `INSERT INTO user_page_preferences (user_id, config_json, config_version)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE config_json=VALUES(config_json), config_version=1`,
      [userId, JSON.stringify(config)]
    );
  }

  async markConfigDecided(userId) {
    await this.requirePool().execute(
      'UPDATE users SET config_decided_at=COALESCE(config_decided_at, NOW()) WHERE id=?',
      [userId]
    );
  }

  async changePassword(userId, { passwordHash, username }) {
    if (username) {
      await this.requirePool().execute(
        'UPDATE users SET username=?, password_hash=? WHERE id=?',
        [username, passwordHash, userId]
      );
    } else {
      await this.requirePool().execute('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, userId]);
    }
    return this.findUserById(userId);
  }

  async createOAuthState({ stateHash, provider, returnTo, expiresAt }) {
    await this.requirePool().execute(
      'INSERT INTO user_oauth_states (state_hash, provider, return_to, expires_at) VALUES (?, ?, ?, ?)',
      [stateHash, provider, returnTo, expiresAt]
    );
  }

  async consumeOAuthState(stateHash) {
    const connection = await this.requirePool().getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM user_oauth_states WHERE state_hash=? FOR UPDATE',
        [stateHash]
      );
      const row = rows[0];
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) {
        await connection.rollback();
        return null;
      }
      await connection.execute('UPDATE user_oauth_states SET consumed_at=NOW() WHERE state_hash=?', [stateHash]);
      await connection.commit();
      return row;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listNotes(userId) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, folder_id, title, LEFT(content, 200) AS summary, created_at, updated_at
       FROM user_notes WHERE user_id=? ORDER BY updated_at DESC LIMIT 200`,
      [userId]
    );
    return rows;
  }

  async createNote(userId, { title, content, folderId = null }) {
    const [result] = await this.requirePool().execute(
      'INSERT INTO user_notes (user_id, folder_id, title, content) VALUES (?, ?, ?, ?)',
      [userId, folderId, title, content]
    );
    return this.getNote(userId, result.insertId);
  }

  async getNote(userId, noteId) {
    const [rows] = await this.requirePool().execute(
      'SELECT * FROM user_notes WHERE id=? AND user_id=? LIMIT 1',
      [noteId, userId]
    );
    return rows[0] || null;
  }

  async updateNote(userId, noteId, { title, content, folderId }) {
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('title=?'); params.push(title); }
    if (content !== undefined) { sets.push('content=?'); params.push(content); }
    if (folderId !== undefined) { sets.push('folder_id=?'); params.push(folderId); }
    if (!sets.length) return this.getNote(userId, noteId);
    params.push(noteId, userId);
    await this.requirePool().execute(
      `UPDATE user_notes SET ${sets.join(',')} WHERE id=? AND user_id=?`, params
    );
    return this.getNote(userId, noteId);
  }

  async deleteNote(userId, noteId) {
    const [result] = await this.requirePool().execute(
      'DELETE FROM user_notes WHERE id=? AND user_id=?',
      [noteId, userId]
    );
    return result.affectedRows > 0;
  }

  async listNoteFolders(userId) {
    const [rows] = await this.requirePool().execute(
      `SELECT f.id, f.name, f.created_at, f.updated_at, COUNT(n.id) AS note_count
       FROM user_note_folders f
       LEFT JOIN user_notes n ON n.folder_id=f.id AND n.user_id=f.user_id
       WHERE f.user_id=?
       GROUP BY f.id, f.name, f.created_at, f.updated_at
       ORDER BY f.name ASC, f.id ASC`,
      [userId]
    );
    return rows;
  }

  async getNoteFolder(userId, folderId) {
    const [rows] = await this.requirePool().execute(
      'SELECT * FROM user_note_folders WHERE id=? AND user_id=? LIMIT 1',
      [folderId, userId]
    );
    return rows[0] || null;
  }

  async createNoteFolder(userId, name) {
    const [result] = await this.requirePool().execute(
      'INSERT INTO user_note_folders (user_id, name) VALUES (?, ?)',
      [userId, name]
    );
    return this.getNoteFolder(userId, result.insertId);
  }

  async updateNoteFolder(userId, folderId, name) {
    const [result] = await this.requirePool().execute(
      'UPDATE user_note_folders SET name=? WHERE id=? AND user_id=?',
      [name, folderId, userId]
    );
    return result.affectedRows ? this.getNoteFolder(userId, folderId) : null;
  }

  async deleteNoteFolder(userId, folderId) {
    const [result] = await this.requirePool().execute(
      'DELETE FROM user_note_folders WHERE id=? AND user_id=?',
      [folderId, userId]
    );
    return result.affectedRows > 0;
  }

  async getAiFeatureSetting() {
    const [rows] = await this.requirePool().execute(
      "SELECT is_public, updated_by_user_id, updated_at FROM ai_feature_settings WHERE feature_key='ai_chat' LIMIT 1"
    );
    return rows[0] || { is_public:0, updated_by_user_id:null, updated_at:null };
  }

  async setAiFeatureSetting({ isPublic, updatedByUserId }) {
    await this.requirePool().execute(
      `INSERT INTO ai_feature_settings (feature_key, is_public, updated_by_user_id)
       VALUES ('ai_chat', ?, ?)
       ON DUPLICATE KEY UPDATE is_public=VALUES(is_public), updated_by_user_id=VALUES(updated_by_user_id)`,
      [isPublic ? 1 : 0, updatedByUserId]
    );
    return this.getAiFeatureSetting();
  }

  async hasAiUserPermission(userId) {
    const [rows] = await this.requirePool().execute(
      "SELECT 1 FROM ai_user_permissions WHERE user_id=? AND feature_key='ai_chat' LIMIT 1", [userId]
    );
    return rows.length > 0;
  }

  async listAiPermissionUsers() {
    const [rows] = await this.requirePool().execute(
      `SELECT u.id, u.username, u.display_name, u.status, u.is_admin,
              u.last_login_at, u.created_at, p.granted_by_user_id, p.updated_at AS ai_chat_granted_at,
              CASE WHEN p.user_id IS NULL THEN 0 ELSE 1 END AS ai_chat_granted
       FROM users u
       LEFT JOIN ai_user_permissions p ON p.user_id=u.id AND p.feature_key='ai_chat'
       WHERE u.status='active'
       ORDER BY u.is_admin DESC, u.created_at DESC, u.id DESC LIMIT 500`
    );
    return rows;
  }

  async setAiUserPermission({ userId, canUse, grantedByUserId }) {
    if (canUse) {
      await this.requirePool().execute(
        `INSERT INTO ai_user_permissions (user_id, feature_key, granted_by_user_id)
         VALUES (?, 'ai_chat', ?)
         ON DUPLICATE KEY UPDATE granted_by_user_id=VALUES(granted_by_user_id)`,
        [userId, grantedByUserId]
      );
    } else {
      await this.requirePool().execute(
        "DELETE FROM ai_user_permissions WHERE user_id=? AND feature_key='ai_chat'", [userId]
      );
    }
    return this.hasAiUserPermission(userId);
  }

  async listAiModelConfigs() {
    const [rows] = await this.requirePool().execute(
      `SELECT id, name, model_name, base_url, protocol, is_active, created_by_user_id, created_at, updated_at
       FROM ai_model_configs ORDER BY is_active DESC, id ASC LIMIT 100`
    );
    return rows;
  }

  async getAiModelConfig(id) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, name, model_name, base_url, protocol, api_key_encrypted, is_active, created_by_user_id, created_at, updated_at
       FROM ai_model_configs WHERE id=? LIMIT 1`, [id]
    );
    return rows[0] || null;
  }

  async getActiveAiModelConfig() {
    const [rows] = await this.requirePool().execute(
      `SELECT id, name, model_name, base_url, protocol, api_key_encrypted, is_active, created_by_user_id, created_at, updated_at
       FROM ai_model_configs WHERE is_active=1 ORDER BY id ASC LIMIT 1`
    );
    return rows[0] || null;
  }

  async listActiveAiModelConfigs() {
    const [rows] = await this.requirePool().execute(
      `SELECT id, name, model_name, base_url, protocol, api_key_encrypted, is_active, created_by_user_id, created_at, updated_at
       FROM ai_model_configs WHERE is_active=1 ORDER BY id ASC LIMIT 100`
    );
    return rows;
  }

  async createAiModelConfig({ name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive, createdByUserId }) {
    const [result] = await this.requirePool().execute(
      `INSERT INTO ai_model_configs (name, model_name, base_url, protocol, api_key_encrypted, is_active, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive ? 1 : 0, createdByUserId]
    );
    return this.getAiModelConfig(result.insertId);
  }

  async updateAiModelConfig(id, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive }) {
    const sets = ['name=?', 'model_name=?', 'base_url=?', 'protocol=?', 'is_active=?'];
    const params = [name, modelName, baseUrl, protocol, isActive ? 1 : 0];
    if (apiKeyEncrypted) { sets.push('api_key_encrypted=?'); params.push(apiKeyEncrypted); }
    params.push(id);
    const [result] = await this.requirePool().execute(`UPDATE ai_model_configs SET ${sets.join(',')} WHERE id=?`, params);
    return result.affectedRows ? this.getAiModelConfig(id) : null;
  }

  async deleteAiModelConfig(id) {
    const [result] = await this.requirePool().execute('DELETE FROM ai_model_configs WHERE id=?', [id]);
    return result.affectedRows > 0;
  }

  async listUserAiModelConfigs(userId) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, user_id, name, model_name, base_url, protocol, is_active, created_at, updated_at
       FROM user_ai_model_configs WHERE user_id=? ORDER BY is_active DESC, id ASC LIMIT 20`,
      [userId]
    );
    return rows;
  }

  async getUserAiModelConfig(userId, id) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, user_id, name, model_name, base_url, protocol, api_key_encrypted, is_active, created_at, updated_at
       FROM user_ai_model_configs WHERE id=? AND user_id=? LIMIT 1`,
      [id, userId]
    );
    return rows[0] || null;
  }

  async getActiveUserAiModelConfig(userId) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, user_id, name, model_name, base_url, protocol, api_key_encrypted, is_active, created_at, updated_at
       FROM user_ai_model_configs WHERE user_id=? AND is_active=1 ORDER BY id ASC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  async listActiveUserAiModelConfigs(userId) {
    const [rows] = await this.requirePool().execute(
      `SELECT id, user_id, name, model_name, base_url, protocol, api_key_encrypted, is_active, created_at, updated_at
       FROM user_ai_model_configs WHERE user_id=? AND is_active=1 ORDER BY id ASC LIMIT 20`,
      [userId]
    );
    return rows;
  }

  async createUserAiModelConfig(userId, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive }) {
    const [result] = await this.requirePool().execute(
      `INSERT INTO user_ai_model_configs (user_id, name, model_name, base_url, protocol, api_key_encrypted, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive ? 1 : 0]
    );
    return this.getUserAiModelConfig(userId, result.insertId);
  }

  async updateUserAiModelConfig(userId, id, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive }) {
    const sets = ['name=?', 'model_name=?', 'base_url=?', 'protocol=?', 'is_active=?'];
    const params = [name, modelName, baseUrl, protocol, isActive ? 1 : 0];
    if (apiKeyEncrypted) { sets.push('api_key_encrypted=?'); params.push(apiKeyEncrypted); }
    params.push(id, userId);
    const [result] = await this.requirePool().execute(
      `UPDATE user_ai_model_configs SET ${sets.join(',')} WHERE id=? AND user_id=?`, params
    );
    if (!result.affectedRows) return null;
    return this.getUserAiModelConfig(userId, id);
  }

  async deleteUserAiModelConfig(userId, id) {
    const [result] = await this.requirePool().execute('DELETE FROM user_ai_model_configs WHERE id=? AND user_id=?', [id, userId]);
    return result.affectedRows > 0;
  }

  async createAiConversation(userId, { id, title }) {
    await this.requirePool().execute('INSERT INTO ai_conversations (id, user_id, title) VALUES (?, ?, ?)', [id, userId, title]);
    return this.getAiConversation(userId, id);
  }

  async listAiConversations(userId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const [rows] = await this.requirePool().execute(
      `SELECT c.id, c.title, c.summary, c.created_at, c.updated_at, COUNT(m.id) AS message_count
       FROM ai_conversations c LEFT JOIN ai_messages m ON m.conversation_id=c.id
       WHERE c.user_id=? GROUP BY c.id, c.title, c.summary, c.created_at, c.updated_at
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ${safeLimit}`,
      [userId]
    );
    return rows;
  }

  async getAiConversation(userId, id) {
    const [rows] = await this.requirePool().execute(
      'SELECT id, user_id, title, summary, created_at, updated_at FROM ai_conversations WHERE id=? AND user_id=? LIMIT 1', [id, userId]
    );
    return rows[0] || null;
  }

  async updateAiConversation(userId, id, { title, summary }) {
    const sets = [];
    const params = [];
    if (title !== undefined) { sets.push('title=?'); params.push(title); }
    if (summary !== undefined) { sets.push('summary=?'); params.push(summary); }
    if (!sets.length) return this.getAiConversation(userId, id);
    params.push(id, userId);
    const [result] = await this.requirePool().execute(`UPDATE ai_conversations SET ${sets.join(',')} WHERE id=? AND user_id=?`, params);
    return result.affectedRows ? this.getAiConversation(userId, id) : null;
  }

  async deleteAiConversation(userId, id) {
    const [result] = await this.requirePool().execute('DELETE FROM ai_conversations WHERE id=? AND user_id=?', [id, userId]);
    return result.affectedRows > 0;
  }

  async createAiMessage(conversationId, { role, content, status = 'complete' }) {
    const [result] = await this.requirePool().execute(
      'INSERT INTO ai_messages (conversation_id, role, content, status) VALUES (?, ?, ?, ?)', [conversationId, role, content, status]
    );
    const [rows] = await this.requirePool().execute(
      'SELECT id, conversation_id, role, content, status, created_at FROM ai_messages WHERE id=? LIMIT 1', [result.insertId]
    );
    return rows[0] || null;
  }

  async listAiMessages(userId, conversationId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const [rows] = await this.requirePool().execute(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.status, m.created_at
       FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id
       WHERE m.conversation_id=? AND c.user_id=? ORDER BY m.id DESC LIMIT ${safeLimit}`,
      [conversationId, userId]
    );
    return rows.reverse();
  }

  async recordAiUsage({ userId, conversationId, messageId, modelConfigId = null, userModelConfigId = null, provider, modelName, inputTokens, outputTokens, totalTokens }) {
    await this.requirePool().execute(
      `INSERT INTO ai_usage_records (user_id, conversation_id, message_id, model_config_id, user_model_config_id, provider, model_name, input_tokens, output_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, conversationId, messageId || null, modelConfigId, userModelConfigId, provider || '', modelName || '', inputTokens || 0, outputTokens || 0, totalTokens || 0]
    );
  }

  async getAiUsageDashboard({ days = 30 } = {}) {
    const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
    const [totals] = await this.requirePool().execute(
      `SELECT COUNT(*) AS request_count, COUNT(DISTINCT user_id) AS user_count, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(total_tokens) AS total_tokens
       FROM ai_usage_records WHERE created_at>=DATE_SUB(NOW(), INTERVAL ${safeDays} DAY)`
    );
    const [users] = await this.requirePool().execute(
      `SELECT u.id AS user_id, u.display_name, COUNT(r.id) AS request_count, SUM(r.total_tokens) AS total_tokens,
              MAX(r.created_at) AS last_used_at
       FROM ai_usage_records r JOIN users u ON u.id=r.user_id
       WHERE r.created_at>=DATE_SUB(NOW(), INTERVAL ${safeDays} DAY)
       GROUP BY u.id, u.display_name ORDER BY total_tokens DESC, last_used_at DESC LIMIT 100`
    );
    const [models] = await this.requirePool().execute(
      `SELECT model_name, provider, COUNT(*) AS request_count, SUM(total_tokens) AS total_tokens
       FROM ai_usage_records WHERE created_at>=DATE_SUB(NOW(), INTERVAL ${safeDays} DAY)
       GROUP BY model_name, provider ORDER BY total_tokens DESC LIMIT 50`
    );
    return { totals:totals[0] || {}, users, models };
  }

  async cleanup() {
    await this.requirePool().query('DELETE FROM user_sessions WHERE expires_at<=NOW()');
    await this.requirePool().query('DELETE FROM user_oauth_states WHERE expires_at<=NOW() OR consumed_at IS NOT NULL');
    await this.requirePool().query(
      `DELETE FROM stock_fund_flow_history_cache
       WHERE fetched_at < DATE_SUB(NOW(), INTERVAL ${FUND_FLOW_HISTORY_CACHE_RETENTION_DAYS} DAY)`
    );
  }
}

class MemoryAccountDatabase {
  constructor() {
    this.users = new Map();
    this.usernames = new Map();
    this.identities = new Map();
    this.sessions = new Map();
    this.preferences = new Map();
    this.states = new Map();
    this.notes = new Map();
    this.noteFolders = new Map();
    this.fundFlowHistoryCache = new Map();
    this.chatMessages = [];
    this.siteRecommendations = [];
    this.referenceDocuments = [];
    this.aiFeatureSetting = { is_public:0, updated_by_user_id:null, updated_at:null };
    this.aiUserPermissions = new Map();
    this.aiModels = [];
    this.userAiModels = [];
    this.aiConversations = new Map();
    this.aiMessages = [];
    this.aiUsageRecords = [];
    this.nextUserId = 1;
    this.nextSessionId = 1;
    this.nextNoteId = 1;
    this.nextNoteFolderId = 1;
    this.nextSiteRecommendationId = 1;
    this.nextReferenceDocumentId = 1;
    this.nextChatMessageId = 1;
    this.nextAiModelId = 1;
    this.nextUserAiModelId = 1;
    this.nextAiMessageId = 1;
    this.nextAiUsageId = 1;
  }

  async initialize() {}
  async close() {}

  async listSiteRecommendations({ includeAdminOnly = false } = {}) {
    return this.siteRecommendations
      .filter(site => site.is_active && (includeAdminOnly || !site.is_admin_only))
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .slice(0, 50)
      .map(({ id, name, url, description, is_admin_only }) => ({ id, name, url, description, is_admin_only }));
  }

  async listAllSiteRecommendations() {
    return this.siteRecommendations
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map(site => ({ ...site }));
  }

  async getSiteRecommendation(id) {
    const site = this.siteRecommendations.find(item => item.id === Number(id));
    return site ? { ...site } : null;
  }

  async createSiteRecommendation({ name, url, description, sortOrder, isActive, isAdminOnly }) {
    if (this.siteRecommendations.some(site => site.url === url)) {
      throw Object.assign(new Error('Duplicate site URL'), { code:'ER_DUP_ENTRY' });
    }
    const now = new Date();
    const site = {
      id:this.nextSiteRecommendationId++, name, url, description,
      sort_order:sortOrder, is_active:isActive ? 1 : 0, is_admin_only:isAdminOnly ? 1 : 0,
      created_at:now, updated_at:now,
    };
    this.siteRecommendations.push(site);
    return { ...site };
  }

  async updateSiteRecommendation(id, { name, url, description, sortOrder, isActive, isAdminOnly }) {
    const site = this.siteRecommendations.find(item => item.id === Number(id));
    if (!site) return null;
    if (this.siteRecommendations.some(item => item.id !== site.id && item.url === url)) {
      throw Object.assign(new Error('Duplicate site URL'), { code:'ER_DUP_ENTRY' });
    }
    Object.assign(site, {
      name, url, description, sort_order:sortOrder, is_active:isActive ? 1 : 0,
      is_admin_only:isAdminOnly ? 1 : 0, updated_at:new Date(),
    });
    return { ...site };
  }

  async deleteSiteRecommendation(id) {
    const index = this.siteRecommendations.findIndex(item => item.id === Number(id));
    if (index < 0) return false;
    this.siteRecommendations.splice(index, 1);
    return true;
  }

  async listReferenceDocuments({ includeInactive = false, includeContent = false } = {}) {
    return this.referenceDocuments
      .filter(document => includeInactive || document.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .slice(0, 200)
      .map(document => includeContent ? { ...document } : { ...document, content:undefined });
  }

  async getReferenceDocument(id, { includeInactive = false } = {}) {
    const document = this.referenceDocuments.find(item => item.id === Number(id));
    if (!document || (!includeInactive && !document.is_active)) return null;
    return { ...document };
  }

  async createReferenceDocument({ title, description, content, sortOrder, isActive, userId }) {
    const now = new Date();
    const document = {
      id:this.nextReferenceDocumentId++, title, description, content,
      sort_order:sortOrder, is_active:isActive ? 1 : 0,
      created_by_user_id:userId == null ? null : Number(userId),
      updated_by_user_id:userId == null ? null : Number(userId),
      created_at:now, updated_at:now,
    };
    this.referenceDocuments.push(document);
    return { ...document };
  }

  async updateReferenceDocument(id, { title, description, content, sortOrder, isActive, userId }) {
    const document = this.referenceDocuments.find(item => item.id === Number(id));
    if (!document) return null;
    Object.assign(document, {
      title, description, content, sort_order:sortOrder, is_active:isActive ? 1 : 0,
      updated_by_user_id:userId == null ? null : Number(userId), updated_at:new Date(),
    });
    return { ...document };
  }

  async deleteReferenceDocument(id) {
    const index = this.referenceDocuments.findIndex(item => item.id === Number(id));
    if (index < 0) return false;
    this.referenceDocuments.splice(index, 1);
    return true;
  }

  async seedReferenceDocument({ title, description = '', content, sortOrder = 0 }) {
    if (this.referenceDocuments.length) return false;
    await this.createReferenceDocument({ title, description, content, sortOrder, isActive:true, userId:null });
    return true;
  }

  async getFundFlowHistoryCache(symbol) {
    const item = this.fundFlowHistoryCache.get(symbol);
    return item ? structuredClone(item) : null;
  }

  async saveFundFlowHistoryCache(symbol, value) {
    this.fundFlowHistoryCache.set(symbol, structuredClone(value));
  }

  async createChatMessage(userId, message) {
    const row = {
      id:this.nextChatMessageId++,
      user_id:Number(userId),
      message_type:message.type,
      text_content:message.text || null,
      image_data:message.imageData || null,
      image_mime:message.imageMime || null,
      display_name:message.displayName,
      avatar_url:message.avatarUrl || null,
      created_at:new Date(message.time),
    };
    this.chatMessages.push(row);
    return structuredClone(row);
  }

  async listChatMessages({ beforeId = null, since = null, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const sinceDate = parseShanghaiDateTime(since);
    let candidates = this.chatMessages.filter(row => beforeId
      ? row.id < Number(beforeId)
      : row.created_at >= sinceDate);
    candidates = candidates.sort((a, b) => b.id - a.id);
    let hasMore = candidates.length > safeLimit;
    const rows = candidates.slice(0, safeLimit);
    let nextCursor = rows.length ? String(rows[rows.length - 1].id) : null;
    if (!beforeId && !hasMore) {
      const older = this.chatMessages
        .filter(row => nextCursor ? row.id < Number(nextCursor) : row.created_at < sinceDate)
        .sort((a, b) => b.id - a.id)[0];
      if (older) {
        hasMore = true;
        if (!nextCursor) nextCursor = String(older.id + 1);
      }
    }
    return { messages:structuredClone(rows.reverse()), nextCursor:hasMore ? nextCursor : null, hasMore };
  }

  cloneUser(user) { return user ? { ...user } : null; }

  async createPasswordUser({ username, passwordHash, displayName }) {
    if (this.usernames.has(username)) throw Object.assign(new Error('Duplicate username'), { code: 'ER_DUP_ENTRY' });
    const now = new Date();
    const user = {
      id: this.nextUserId++, username, password_hash: passwordHash, display_name: displayName,
      avatar_url: null, custom_avatar_data: null, status: 'active', is_admin:0, config_decided_at: null, last_login_at: now,
      created_at: now, updated_at: now,
    };
    this.users.set(user.id, user);
    this.usernames.set(username, user.id);
    return this.cloneUser(user);
  }

  async findUserById(id) { return this.cloneUser(this.users.get(Number(id))); }
  async findUserByUsername(username) { return this.cloneUser(this.users.get(this.usernames.get(username))); }
  async setUserAdmin({ userId, isAdmin }) {
    const user = this.users.get(Number(userId));
    if (!user || user.status !== 'active') return null;
    if (!isAdmin && Number(user.is_admin) === 1) {
      const activeAdminCount = [...this.users.values()]
        .filter(item => item.status === 'active' && Number(item.is_admin) === 1).length;
      if (activeAdminCount <= 1) {
        throw Object.assign(new Error('At least one active administrator is required'), { code:'LAST_ACTIVE_ADMIN' });
      }
    }
    user.is_admin = isAdmin ? 1 : 0;
    user.updated_at = new Date();
    return this.cloneUser(user);
  }
  async updateLastLogin(userId) {
    const user = this.users.get(Number(userId));
    if (user) user.last_login_at = new Date();
  }

  async updateAvatar(userId, avatarData) {
    const user = this.users.get(Number(userId));
    if (!user) return null;
    user.custom_avatar_data = avatarData || null;
    user.updated_at = new Date();
    return this.cloneUser(user);
  }

  async updateProfile(userId, { displayName }) {
    const user = this.users.get(Number(userId));
    if (!user) return null;
    user.display_name = displayName;
    user.updated_at = new Date();
    return this.cloneUser(user);
  }

  async upsertWechatUser({ providerUserId, openid, unionid, displayName, avatarUrl, profile }) {
    let user = this.users.get(this.identities.get(providerUserId)?.userId);
    if (!user) {
      const now = new Date();
      user = {
        id: this.nextUserId++, username: null, password_hash: null, display_name: displayName,
        avatar_url: avatarUrl || null, custom_avatar_data: null, status: 'active', is_admin:0, config_decided_at: null, last_login_at: now,
        created_at: now, updated_at: now,
      };
      this.users.set(user.id, user);
    } else {
      user.avatar_url = avatarUrl || null;
      user.last_login_at = new Date();
    }
    this.identities.set(providerUserId, { userId: user.id, openid, unionid, profile });
    return this.cloneUser(user);
  }

  async createSession({ userId, tokenHash, expiresAt }) {
    this.sessions.set(tokenHash, {
      session_id: this.nextSessionId++, userId: Number(userId), session_expires_at: expiresAt, last_seen_at: new Date(),
    });
  }

  async findSession(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session || new Date(session.session_expires_at).getTime() <= Date.now()) return null;
    const user = this.users.get(session.userId);
    if (!user || user.status !== 'active') return null;
    return { ...session, ...this.cloneUser(user) };
  }

  async touchSession(sessionId) {
    for (const session of this.sessions.values()) {
      if (session.session_id === sessionId) session.last_seen_at = new Date();
    }
  }

  async deleteSession(tokenHash) { this.sessions.delete(tokenHash); }
  async getPreferences(userId) { return this.preferences.has(Number(userId)) ? structuredClone(this.preferences.get(Number(userId))) : null; }
  async savePreferences(userId, config) { this.preferences.set(Number(userId), structuredClone(config)); }
  async markConfigDecided(userId) {
    const user = this.users.get(Number(userId));
    if (user && !user.config_decided_at) user.config_decided_at = new Date();
  }

  async changePassword(userId, { passwordHash, username }) {
    const user = this.users.get(Number(userId));
    if (!user) return null;
    if (username) {
      const existing = this.usernames.get(username);
      if (existing && existing !== user.id) throw Object.assign(new Error('Duplicate username'), { code: 'ER_DUP_ENTRY' });
      if (user.username) this.usernames.delete(user.username);
      user.username = username;
      this.usernames.set(username, user.id);
    }
    user.password_hash = passwordHash;
    user.updated_at = new Date();
    return this.cloneUser(user);
  }

  async createOAuthState({ stateHash, provider, returnTo, expiresAt }) {
    this.states.set(stateHash, { state_hash: stateHash, provider, return_to: returnTo, expires_at: expiresAt, consumed_at: null });
  }

  async consumeOAuthState(stateHash) {
    const state = this.states.get(stateHash);
    if (!state || state.consumed_at || new Date(state.expires_at).getTime() <= Date.now()) return null;
    state.consumed_at = new Date();
    return { ...state };
  }

  async listNotes(userId) {
    const userNotes = [];
    for (const note of this.notes.values()) {
      if (note.user_id === Number(userId)) {
        userNotes.push({ ...note, summary: note.content.slice(0, 200) });
      }
    }
    userNotes.sort((a, b) => b.updated_at - a.updated_at);
    return userNotes.slice(0, 200);
  }

  async createNote(userId, { title, content, folderId = null }) {
    const now = new Date();
    const note = {
      id: this.nextNoteId++, user_id: Number(userId),
      folder_id: folderId == null ? null : Number(folderId), title, content, created_at: now, updated_at: now,
    };
    this.notes.set(note.id, note);
    return { ...note };
  }

  async getNote(userId, noteId) {
    const note = this.notes.get(Number(noteId));
    if (!note || note.user_id !== Number(userId)) return null;
    return { ...note };
  }

  async updateNote(userId, noteId, { title, content, folderId }) {
    const note = this.notes.get(Number(noteId));
    if (!note || note.user_id !== Number(userId)) return null;
    if (title !== undefined) note.title = title;
    if (content !== undefined) note.content = content;
    if (folderId !== undefined) note.folder_id = folderId == null ? null : Number(folderId);
    note.updated_at = new Date();
    return { ...note };
  }

  async deleteNote(userId, noteId) {
    const note = this.notes.get(Number(noteId));
    if (!note || note.user_id !== Number(userId)) return false;
    this.notes.delete(Number(noteId));
    return true;
  }

  async listNoteFolders(userId) {
    const folders = [];
    for (const folder of this.noteFolders.values()) {
      if (folder.user_id !== Number(userId)) continue;
      let noteCount = 0;
      for (const note of this.notes.values()) {
        if (note.user_id === Number(userId) && note.folder_id === folder.id) noteCount += 1;
      }
      folders.push({ ...folder, note_count:noteCount });
    }
    return folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id - b.id);
  }

  async getNoteFolder(userId, folderId) {
    const folder = this.noteFolders.get(Number(folderId));
    return folder && folder.user_id === Number(userId) ? { ...folder } : null;
  }

  async createNoteFolder(userId, name) {
    const duplicate = [...this.noteFolders.values()].some(folder =>
      folder.user_id === Number(userId) && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) throw Object.assign(new Error('Duplicate folder name'), { code:'ER_DUP_ENTRY' });
    const now = new Date();
    const folder = {
      id:this.nextNoteFolderId++, user_id:Number(userId), name,
      created_at:now, updated_at:now,
    };
    this.noteFolders.set(folder.id, folder);
    return { ...folder };
  }

  async updateNoteFolder(userId, folderId, name) {
    const folder = this.noteFolders.get(Number(folderId));
    if (!folder || folder.user_id !== Number(userId)) return null;
    const duplicate = [...this.noteFolders.values()].some(item =>
      item.id !== folder.id && item.user_id === Number(userId) && item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) throw Object.assign(new Error('Duplicate folder name'), { code:'ER_DUP_ENTRY' });
    folder.name = name;
    folder.updated_at = new Date();
    return { ...folder };
  }

  async deleteNoteFolder(userId, folderId) {
    const folder = this.noteFolders.get(Number(folderId));
    if (!folder || folder.user_id !== Number(userId)) return false;
    this.noteFolders.delete(folder.id);
    for (const note of this.notes.values()) {
      if (note.user_id === Number(userId) && note.folder_id === folder.id) note.folder_id = null;
    }
    return true;
  }

  async getAiFeatureSetting() { return { ...this.aiFeatureSetting }; }

  async setAiFeatureSetting({ isPublic, updatedByUserId }) {
    this.aiFeatureSetting = { is_public:isPublic ? 1 : 0, updated_by_user_id:Number(updatedByUserId), updated_at:new Date() };
    return this.getAiFeatureSetting();
  }

  async hasAiUserPermission(userId) {
    return this.aiUserPermissions.has(`ai_chat:${Number(userId)}`);
  }

  async listAiPermissionUsers() {
    return [...this.users.values()]
      .filter(user => user.status === 'active')
      .sort((left, right) => Number(right.is_admin) - Number(left.is_admin) || right.created_at - left.created_at || right.id - left.id)
      .slice(0, 500)
      .map(user => {
        const permission = this.aiUserPermissions.get(`ai_chat:${user.id}`);
        return {
          ...this.cloneUser(user),
          ai_chat_granted:permission ? 1 : 0,
          granted_by_user_id:permission?.granted_by_user_id || null,
          ai_chat_granted_at:permission?.updated_at || null,
        };
      });
  }

  async setAiUserPermission({ userId, canUse, grantedByUserId }) {
    const key = `ai_chat:${Number(userId)}`;
    if (canUse) {
      const now = new Date();
      const existing = this.aiUserPermissions.get(key);
      this.aiUserPermissions.set(key, {
        user_id:Number(userId), feature_key:'ai_chat', granted_by_user_id:Number(grantedByUserId),
        created_at:existing?.created_at || now, updated_at:now,
      });
    } else {
      this.aiUserPermissions.delete(key);
    }
    return this.hasAiUserPermission(userId);
  }

  async listAiModelConfigs() {
    return this.aiModels.map(({ api_key_encrypted, ...item }) => ({ ...item }));
  }

  async getAiModelConfig(id) {
    const item = this.aiModels.find(model => model.id === Number(id));
    return item ? { ...item } : null;
  }

  async getActiveAiModelConfig() {
    const item = this.aiModels.find(model => model.is_active);
    return item ? { ...item } : null;
  }

  async listActiveAiModelConfigs() {
    return this.aiModels.filter(model => model.is_active).map(model => ({ ...model }));
  }

  async createAiModelConfig({ name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive, createdByUserId }) {
    const item = {
      id:this.nextAiModelId++, name, model_name:modelName, base_url:baseUrl, protocol,
      api_key_encrypted:apiKeyEncrypted, is_active:isActive ? 1 : 0,
      created_by_user_id:Number(createdByUserId), created_at:new Date(), updated_at:new Date(),
    };
    this.aiModels.push(item);
    return { ...item };
  }

  async updateAiModelConfig(id, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive }) {
    const item = this.aiModels.find(model => model.id === Number(id));
    if (!item) return null;
    Object.assign(item, { name, model_name:modelName, base_url:baseUrl, protocol, is_active:isActive ? 1 : 0, updated_at:new Date() });
    if (apiKeyEncrypted) item.api_key_encrypted = apiKeyEncrypted;
    return { ...item };
  }

  async deleteAiModelConfig(id) {
    const index = this.aiModels.findIndex(model => model.id === Number(id));
    if (index < 0) return false;
    this.aiModels.splice(index, 1);
    return true;
  }

  async listUserAiModelConfigs(userId) {
    return this.userAiModels
      .filter(model => model.user_id === Number(userId))
      .sort((left, right) => Number(right.is_active) - Number(left.is_active) || left.id - right.id)
      .map(({ api_key_encrypted, ...model }) => ({ ...model }));
  }

  async getUserAiModelConfig(userId, id) {
    const item = this.userAiModels.find(model => model.id === Number(id) && model.user_id === Number(userId));
    return item ? { ...item } : null;
  }

  async getActiveUserAiModelConfig(userId) {
    const item = this.userAiModels.find(model => model.user_id === Number(userId) && model.is_active);
    return item ? { ...item } : null;
  }

  async listActiveUserAiModelConfigs(userId) {
    return this.userAiModels
      .filter(model => model.user_id === Number(userId) && model.is_active)
      .sort((left, right) => left.id - right.id)
      .map(model => ({ ...model }));
  }

  async createUserAiModelConfig(userId, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive }) {
    const item = {
      id:this.nextUserAiModelId++, user_id:Number(userId), name, model_name:modelName, base_url:baseUrl, protocol,
      api_key_encrypted:apiKeyEncrypted, is_active:isActive ? 1 : 0, created_at:new Date(), updated_at:new Date(),
    };
    this.userAiModels.push(item);
    return { ...item };
  }

  async updateUserAiModelConfig(userId, id, { name, modelName, baseUrl, protocol, apiKeyEncrypted, isActive }) {
    const item = this.userAiModels.find(model => model.id === Number(id) && model.user_id === Number(userId));
    if (!item) return null;
    Object.assign(item, { name, model_name:modelName, base_url:baseUrl, protocol, is_active:isActive ? 1 : 0, updated_at:new Date() });
    if (apiKeyEncrypted) item.api_key_encrypted = apiKeyEncrypted;
    return { ...item };
  }

  async deleteUserAiModelConfig(userId, id) {
    const index = this.userAiModels.findIndex(model => model.id === Number(id) && model.user_id === Number(userId));
    if (index < 0) return false;
    this.userAiModels.splice(index, 1);
    return true;
  }

  async createAiConversation(userId, { id, title }) {
    const row = { id, user_id:Number(userId), title, summary:null, created_at:new Date(), updated_at:new Date() };
    this.aiConversations.set(id, row);
    return { ...row };
  }

  async listAiConversations(userId, limit = 100) {
    return [...this.aiConversations.values()]
      .filter(row => row.user_id === Number(userId))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit)
      .map(row => ({ ...row, message_count:this.aiMessages.filter(message => message.conversation_id === row.id).length }));
  }

  async getAiConversation(userId, id) {
    const row = this.aiConversations.get(id);
    return row?.user_id === Number(userId) ? { ...row } : null;
  }

  async updateAiConversation(userId, id, { title, summary }) {
    const row = this.aiConversations.get(id);
    if (!row || row.user_id !== Number(userId)) return null;
    if (title !== undefined) row.title = title;
    if (summary !== undefined) row.summary = summary;
    row.updated_at = new Date();
    return { ...row };
  }

  async deleteAiConversation(userId, id) {
    const row = this.aiConversations.get(id);
    if (!row || row.user_id !== Number(userId)) return false;
    this.aiConversations.delete(id);
    this.aiMessages = this.aiMessages.filter(message => message.conversation_id !== id);
    this.aiUsageRecords = this.aiUsageRecords.filter(record => record.conversation_id !== id);
    return true;
  }

  async createAiMessage(conversationId, { role, content, status = 'complete' }) {
    const row = { id:this.nextAiMessageId++, conversation_id:conversationId, role, content, status, created_at:new Date() };
    this.aiMessages.push(row);
    const conversation = this.aiConversations.get(conversationId);
    if (conversation) conversation.updated_at = new Date();
    return { ...row };
  }

  async listAiMessages(userId, conversationId, limit = 100) {
    const conversation = this.aiConversations.get(conversationId);
    if (!conversation || conversation.user_id !== Number(userId)) return [];
    return this.aiMessages.filter(message => message.conversation_id === conversationId).slice(-limit).map(message => ({ ...message }));
  }

  async recordAiUsage({ userId, conversationId, messageId, modelConfigId = null, userModelConfigId = null, provider, modelName, inputTokens, outputTokens, totalTokens }) {
    this.aiUsageRecords.push({
      id:this.nextAiUsageId++, user_id:Number(userId), conversation_id:conversationId, message_id:messageId || null,
      model_config_id:modelConfigId == null ? null : Number(modelConfigId), user_model_config_id:userModelConfigId == null ? null : Number(userModelConfigId), provider:provider || '', model_name:modelName || '',
      input_tokens:Number(inputTokens) || 0, output_tokens:Number(outputTokens) || 0,
      total_tokens:Number(totalTokens) || 0, created_at:new Date(),
    });
  }

  async getAiUsageDashboard({ days = 30 } = {}) {
    const after = Date.now() - Math.max(1, Math.min(365, Number(days) || 30)) * 86400000;
    const rows = this.aiUsageRecords.filter(row => row.created_at.getTime() >= after);
    const total = key => rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
    const userMap = new Map();
    rows.forEach(row => {
      const user = this.users.get(row.user_id);
      const item = userMap.get(row.user_id) || { user_id:row.user_id, display_name:user?.display_name || '用户', request_count:0, total_tokens:0, last_used_at:null };
      item.request_count += 1; item.total_tokens += row.total_tokens;
      if (!item.last_used_at || item.last_used_at < row.created_at) item.last_used_at = row.created_at;
      userMap.set(row.user_id, item);
    });
    const modelMap = new Map();
    rows.forEach(row => {
      const key = `${row.provider}:${row.model_name}`;
      const item = modelMap.get(key) || { provider:row.provider, model_name:row.model_name, request_count:0, total_tokens:0 };
      item.request_count += 1; item.total_tokens += row.total_tokens; modelMap.set(key, item);
    });
    return {
      totals:{ request_count:rows.length, user_count:userMap.size, input_tokens:total('input_tokens'), output_tokens:total('output_tokens'), total_tokens:total('total_tokens') },
      users:[...userMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
      models:[...modelMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    };
  }

  async cleanup() {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (new Date(session.session_expires_at).getTime() <= now) this.sessions.delete(key);
    for (const [key, state] of this.states) if (state.consumed_at || new Date(state.expires_at).getTime() <= now) this.states.delete(key);
    for (const [symbol, value] of this.fundFlowHistoryCache) {
      if (now - new Date(value?.fetchedAt || 0).getTime() > FUND_FLOW_HISTORY_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
        this.fundFlowHistoryCache.delete(symbol);
      }
    }
  }
}

module.exports = {
  AccountDatabase,
  MemoryAccountDatabase,
  SCHEMA_STATEMENTS,
  ensureAdminSchema,
  ensureSiteRecommendationVisibilitySchema,
  ensureNoteFolderSchema,
  ensureAvatarSchema,
  FUND_FLOW_HISTORY_CACHE_RETENTION_DAYS,
  ensureUserAiModelSchema,
};
