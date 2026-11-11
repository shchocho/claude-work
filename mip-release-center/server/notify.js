// In-app notifications, plus an optional copy to an outbound webhook so the
// organisation can forward them to mail or chat. Notifications are written in
// the same transaction as the change that caused them.
import { newId, parseJson, clampInt, uniq } from './util.js';

export function createNotifier({ db, clock, config, users, outbox }) {
  /**
   * Notify users about a request event. `payload` holds only what the client
   * needs to phrase the message in the reader's language.
   */
  function push(userIds, type, { requestId = null, payload = {}, exclude = [] } = {}) {
    const targets = uniq(userIds.filter(Boolean)).filter((id) => !exclude.includes(id));
    if (!targets.length) return;
    const at = clock.now().toISOString();
    const body = JSON.stringify(payload);
    const recipients = [];
    for (const userId of targets) {
      const row = users.rowById(userId);
      if (!row || !row.active) continue;
      db.run('INSERT INTO notifications (id, user_id, type, request_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('ntf'), userId, type, requestId, body, at);
      recipients.push({ id: row.id, login: row.login, name: row.name, email: row.email ?? '' });
    }
    if (config.notifyWebhookUrl && recipients.length) {
      outbox.enqueue('notify', {
        event: type,
        at,
        request: requestId ? { id: requestId, number: payload.number ?? null, title: payload.title ?? null, url: `${config.baseUrl}/#/requests/${requestId}` } : null,
        recipients,
        data: payload,
      }, requestId);
    }
  }

  function fromRow(row) {
    return { id: row.id, type: row.type, requestId: row.request_id, payload: parseJson(row.payload, {}), createdAt: row.created_at, readAt: row.read_at };
  }

  function list(userId, { unreadOnly = false, limit = 30 } = {}) {
    const rows = db.all(
      `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      userId, clampInt(limit, 30, 1, 100),
    );
    return rows.map(fromRow);
  }

  function unreadCount(userId) {
    return db.get('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId).n;
  }

  function markRead(userId, ids) {
    const at = clock.now().toISOString();
    if (ids === 'all') {
      return db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', at, userId).changes;
    }
    let changed = 0;
    for (const id of Array.isArray(ids) ? ids.slice(0, 200) : []) {
      if (typeof id !== 'string') continue;
      changed += db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', at, id, userId).changes;
    }
    return changed;
  }

  /** Keep the table small: read notifications older than 90 days are dropped. */
  function purgeOld() {
    const cutoff = new Date(clock.now().getTime() - 90 * 86400_000).toISOString();
    return db.run('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', cutoff).changes;
  }

  return { push, list, unreadCount, markRead, purgeOld };
}
