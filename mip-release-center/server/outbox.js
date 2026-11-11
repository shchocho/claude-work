// Outbound deliveries (notification webhook, execution dispatch). Rows are
// written in the same transaction as the change that needs them and delivered
// afterwards with retries, so a crash or a slow endpoint never loses or blocks
// a workflow step.
import { newId, hmacHex, addMinutes, parseJson } from './util.js';

const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const MAX_ATTEMPTS = { notify: 4, 'execution.dispatch': 6 };
const TIMEOUT_MS = 10_000;

/** Signature scheme shared by outgoing calls and the execution callback. */
export function signPayload(secret, timestamp, body) {
  return 'sha256=' + hmacHex(secret, `${timestamp}.${body}`);
}

export function createOutbox({ db, clock, config, logger, fetchImpl }) {
  const handlers = { delivered: new Map(), gaveUp: new Map() };
  let running = false;
  let timer = null;
  let kickScheduled = false;

  function enqueue(kind, payload, refId = null) {
    const at = clock.now().toISOString();
    const id = newId('out');
    db.run(
      'INSERT INTO outbox (id, kind, ref_id, payload, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      id, kind, refId, JSON.stringify(payload), 'pending', at, at,
    );
    kick();
    return id;
  }

  /** React to the final outcome of a delivery of the given kind. */
  function on(event, kind, handler) {
    handlers[event].set(kind, handler);
  }

  function target(kind) {
    if (kind === 'notify') return { url: config.notifyWebhookUrl, secret: config.notifyWebhookSecret };
    if (kind === 'execution.dispatch') return { url: config.executorWebhookUrl, secret: config.executorWebhookSecret };
    return { url: '', secret: '' };
  }

  async function deliver(row) {
    const { url, secret } = target(row.kind);
    if (!url) throw new Error('not_configured');
    const timestamp = String(Math.floor(clock.now().getTime() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': `mip-release-center/${config.version}`,
      'X-MRC-Event': row.kind,
      'X-MRC-Delivery': row.id,
      'X-MRC-Timestamp': timestamp,
    };
    if (secret) headers['X-MRC-Signature'] = signPayload(secret, timestamp, row.payload);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: row.payload,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text().catch(() => '');
    return parseJson(text.slice(0, 20_000), null);
  }

  async function processRow(row) {
    const attempt = row.attempts + 1;
    try {
      const response = await deliver(row);
      db.run('UPDATE outbox SET status = ?, attempts = ?, delivered_at = ?, last_error = NULL WHERE id = ?', 'delivered', attempt, clock.now().toISOString(), row.id);
      await handlers.delivered.get(row.kind)?.(row, response);
    } catch (err) {
      const message = String(err?.cause?.code ?? err?.message ?? err).slice(0, 300);
      const max = MAX_ATTEMPTS[row.kind] ?? 3;
      if (attempt >= max || message === 'not_configured') {
        db.run('UPDATE outbox SET status = ?, attempts = ?, last_error = ? WHERE id = ?', 'failed', attempt, message, row.id);
        logger.warn(`outbox ${row.kind} ${row.id} gave up after ${attempt} attempt(s): ${message}`);
        await handlers.gaveUp.get(row.kind)?.(row, message);
      } else {
        const wait = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)];
        db.run(
          'UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
          attempt, message, addMinutes(clock.now(), wait).toISOString(), row.id,
        );
      }
    }
  }

  /** Deliver everything that is due. Safe to call at any time; overlapping calls collapse. */
  async function drain() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const rows = db.all("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 20", clock.now().toISOString());
        if (!rows.length) break;
        for (const row of rows) await processRow(row);
      }
    } finally {
      running = false;
    }
  }

  function kick() {
    if (!timer || kickScheduled) return;
    kickScheduled = true;
    setImmediate(() => {
      kickScheduled = false;
      drain().catch((err) => logger.error('outbox drain failed', err));
    });
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => drain().catch((err) => logger.error('outbox drain failed', err)), config.outboxIntervalSeconds * 1000);
    timer.unref();
    kick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function stats() {
    const rows = db.all('SELECT status, count(*) AS n FROM outbox GROUP BY status');
    const out = { pending: 0, delivered: 0, failed: 0 };
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  /** Drop delivered rows after 30 days; failed ones stay for troubleshooting. */
  function purgeOld() {
    const cutoff = new Date(clock.now().getTime() - 30 * 86400_000).toISOString();
    return db.run("DELETE FROM outbox WHERE status = 'delivered' AND created_at < ?", cutoff).changes;
  }

  return { enqueue, on, drain, start, stop, stats, purgeOld };
}
