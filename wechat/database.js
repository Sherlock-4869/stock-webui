'use strict';

const mysql = require('mysql2/promise');

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS wechat_subscribers (
    openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subscribed TINYINT(1) NOT NULL DEFAULT 1,
    ipo_notify_enabled TINYINT(1) NOT NULL DEFAULT 1,
    source VARCHAR(32) NOT NULL DEFAULT 'callback',
    last_interaction_at DATETIME NULL,
    subscribed_at DATETIME NULL,
    unsubscribed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (openid),
    KEY idx_wechat_subscribers_notify (subscribed, ipo_notify_enabled)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS wechat_push_jobs (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS wechat_push_deliveries (
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
    CONSTRAINT fk_wechat_delivery_job FOREIGN KEY (job_id) REFERENCES wechat_push_jobs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

class WeChatDatabase {
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
    } finally {
      connection.release();
    }
  }

  requirePool() {
    if (!this.pool) throw new Error('WeChat database is not initialized');
    return this.pool;
  }

  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }

  async withAdvisoryLock(lockName, callback) {
    const connection = await this.requirePool().getConnection();
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
      if (Number(rows[0]?.acquired) !== 1) return { locked: false };
      try { return { locked: true, result: await callback() }; }
      finally { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); }
    } finally {
      connection.release();
    }
  }

  async recordSubscribe(openid, autoEnable, source = 'callback') {
    await this.requirePool().execute(
      `INSERT INTO wechat_subscribers
        (openid, subscribed, ipo_notify_enabled, source, subscribed_at, unsubscribed_at)
       VALUES (?, 1, ?, ?, NOW(), NULL)
       ON DUPLICATE KEY UPDATE
        subscribed=1, ipo_notify_enabled=VALUES(ipo_notify_enabled), source=VALUES(source),
        subscribed_at=NOW(), unsubscribed_at=NULL`,
      [openid, autoEnable ? 1 : 0, source]
    );
  }

  async recordUnsubscribe(openid) {
    await this.requirePool().execute(
      `INSERT INTO wechat_subscribers
        (openid, subscribed, ipo_notify_enabled, source, unsubscribed_at)
       VALUES (?, 0, 0, 'callback', NOW())
       ON DUPLICATE KEY UPDATE subscribed=0, ipo_notify_enabled=0, unsubscribed_at=NOW()`,
      [openid]
    );
  }

  async recordInteraction(openid) {
    await this.requirePool().execute(
      `INSERT INTO wechat_subscribers
        (openid, subscribed, ipo_notify_enabled, source, last_interaction_at, subscribed_at)
       VALUES (?, 1, 1, 'message', NOW(), NOW())
       ON DUPLICATE KEY UPDATE subscribed=1, last_interaction_at=NOW(), unsubscribed_at=NULL`,
      [openid]
    );
  }

  async setNotification(openid, enabled) {
    await this.requirePool().execute(
      `INSERT INTO wechat_subscribers
        (openid, subscribed, ipo_notify_enabled, source, subscribed_at)
       VALUES (?, 1, ?, 'message', NOW())
       ON DUPLICATE KEY UPDATE subscribed=1, ipo_notify_enabled=VALUES(ipo_notify_enabled), unsubscribed_at=NULL`,
      [openid, enabled ? 1 : 0]
    );
  }

  async syncFollowers(openids, autoEnable) {
    if (!openids.length) return 0;
    const connection = await this.requirePool().getConnection();
    try {
      await connection.beginTransaction();
      for (const openid of openids) {
        await connection.execute(
          `INSERT INTO wechat_subscribers
            (openid, subscribed, ipo_notify_enabled, source, subscribed_at, unsubscribed_at)
           VALUES (?, 1, ?, 'api_sync', NOW(), NULL)
           ON DUPLICATE KEY UPDATE subscribed=1, source='api_sync', unsubscribed_at=NULL`,
          [openid, autoEnable ? 1 : 0]
        );
      }
      await connection.commit();
      return openids.length;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async activeSubscribers() {
    const [rows] = await this.requirePool().query(
      'SELECT openid FROM wechat_subscribers WHERE subscribed=1 AND ipo_notify_enabled=1 ORDER BY created_at'
    );
    return rows;
  }

  async subscriberStats() {
    const [rows] = await this.requirePool().query(
      `SELECT COUNT(*) AS total,
              SUM(subscribed=1) AS subscribed,
              SUM(subscribed=1 AND ipo_notify_enabled=1) AS enabled
       FROM wechat_subscribers`
    );
    return rows[0] || { total: 0, subscribed: 0, enabled: 0 };
  }

  async createOrGetJob({ jobKey, weekStart, weekEnd, ipoCount, content, scheduledFor }) {
    const [result] = await this.requirePool().execute(
      `INSERT INTO wechat_push_jobs
        (job_key, week_start, week_end, ipo_count, message_content, scheduled_for)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [jobKey, weekStart, weekEnd, ipoCount, content, scheduledFor]
    );
    const id = result.insertId;
    const [rows] = await this.requirePool().execute('SELECT * FROM wechat_push_jobs WHERE id=?', [id]);
    return rows[0];
  }

  async ensureDelivery(jobId, openid) {
    await this.requirePool().execute(
      'INSERT IGNORE INTO wechat_push_deliveries (job_id, openid) VALUES (?, ?)',
      [jobId, openid]
    );
    const [rows] = await this.requirePool().execute(
      'SELECT * FROM wechat_push_deliveries WHERE job_id=? AND openid=?',
      [jobId, openid]
    );
    return rows[0];
  }

  async markDeliverySending(deliveryId) {
    await this.requirePool().execute(
      `UPDATE wechat_push_deliveries
       SET status='sending', attempt_count=attempt_count+1, started_at=NOW(), wechat_errcode=NULL, wechat_errmsg=NULL
       WHERE id=?`,
      [deliveryId]
    );
  }

  async markDeliverySent(deliveryId) {
    await this.requirePool().execute(
      `UPDATE wechat_push_deliveries
       SET status='sent', wechat_errcode=0, wechat_errmsg='ok', sent_at=NOW()
       WHERE id=?`,
      [deliveryId]
    );
  }

  async markDeliveryFailed(deliveryId, errcode, errmsg) {
    await this.requirePool().execute(
      `UPDATE wechat_push_deliveries
       SET status='failed', wechat_errcode=?, wechat_errmsg=?
       WHERE id=?`,
      [Number.isFinite(Number(errcode)) ? Number(errcode) : -1, String(errmsg || 'unknown error').slice(0, 1000), deliveryId]
    );
  }

  async startJob(jobId, recipientCount) {
    await this.requirePool().execute(
      `UPDATE wechat_push_jobs
       SET status='running', recipient_count=?, started_at=COALESCE(started_at, NOW()), last_error=NULL
       WHERE id=?`,
      [recipientCount, jobId]
    );
  }

  async finishJob(jobId, lastError = null) {
    const [rows] = await this.requirePool().execute(
      `SELECT SUM(status='sent') AS success_count,
              SUM(status='failed') AS failure_count,
              SUM(status IN ('pending','sending')) AS pending_count
       FROM wechat_push_deliveries WHERE job_id=?`,
      [jobId]
    );
    const counts = rows[0] || {};
    const success = Number(counts.success_count || 0);
    const failure = Number(counts.failure_count || 0);
    const pending = Number(counts.pending_count || 0);
    const status = failure || pending || lastError ? 'failed' : 'completed';
    await this.requirePool().execute(
      `UPDATE wechat_push_jobs
       SET status=?, success_count=?, failure_count=?, last_error=?, finished_at=NOW()
       WHERE id=?`,
      [status, success, failure, lastError ? String(lastError).slice(0, 1000) : null, jobId]
    );
    return { status, success, failure, pending };
  }
}

module.exports = { WeChatDatabase, SCHEMA_STATEMENTS };
