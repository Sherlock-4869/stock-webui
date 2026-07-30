'use strict';

const mysql = require('mysql2/promise');

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
    password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
    display_name VARCHAR(80) NOT NULL,
    avatar_url VARCHAR(500) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    config_decided_at DATETIME NULL,
    last_login_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_users_username (username),
    KEY idx_users_status (status)
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
];

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

function parseJson(value) {
  if (value == null || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
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
      await ensureNoteFolderSchema(connection, this.config.database);
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

  async updateLastLogin(userId) {
    await this.requirePool().execute('UPDATE users SET last_login_at=NOW() WHERE id=?', [userId]);
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
          `UPDATE users SET display_name=?, avatar_url=?, last_login_at=NOW() WHERE id=?`,
          [displayName, avatarUrl || null, userId]
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

  async cleanup() {
    await this.requirePool().query('DELETE FROM user_sessions WHERE expires_at<=NOW()');
    await this.requirePool().query('DELETE FROM user_oauth_states WHERE expires_at<=NOW() OR consumed_at IS NOT NULL');
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
    this.nextUserId = 1;
    this.nextSessionId = 1;
    this.nextNoteId = 1;
    this.nextNoteFolderId = 1;
  }

  async initialize() {}
  async close() {}

  cloneUser(user) { return user ? { ...user } : null; }

  async createPasswordUser({ username, passwordHash, displayName }) {
    if (this.usernames.has(username)) throw Object.assign(new Error('Duplicate username'), { code: 'ER_DUP_ENTRY' });
    const now = new Date();
    const user = {
      id: this.nextUserId++, username, password_hash: passwordHash, display_name: displayName,
      avatar_url: null, status: 'active', config_decided_at: null, last_login_at: now,
      created_at: now, updated_at: now,
    };
    this.users.set(user.id, user);
    this.usernames.set(username, user.id);
    return this.cloneUser(user);
  }

  async findUserById(id) { return this.cloneUser(this.users.get(Number(id))); }
  async findUserByUsername(username) { return this.cloneUser(this.users.get(this.usernames.get(username))); }
  async updateLastLogin(userId) {
    const user = this.users.get(Number(userId));
    if (user) user.last_login_at = new Date();
  }

  async upsertWechatUser({ providerUserId, openid, unionid, displayName, avatarUrl, profile }) {
    let user = this.users.get(this.identities.get(providerUserId)?.userId);
    if (!user) {
      const now = new Date();
      user = {
        id: this.nextUserId++, username: null, password_hash: null, display_name: displayName,
        avatar_url: avatarUrl || null, status: 'active', config_decided_at: null, last_login_at: now,
        created_at: now, updated_at: now,
      };
      this.users.set(user.id, user);
    } else {
      user.display_name = displayName;
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

  async cleanup() {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (new Date(session.session_expires_at).getTime() <= now) this.sessions.delete(key);
    for (const [key, state] of this.states) if (state.consumed_at || new Date(state.expires_at).getTime() <= now) this.states.delete(key);
  }
}

module.exports = { AccountDatabase, MemoryAccountDatabase, SCHEMA_STATEMENTS, ensureNoteFolderSchema };
