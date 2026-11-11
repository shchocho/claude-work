// Deployment settings. Everything comes from environment variables (prefix MRC_)
// with a few command-line shortcuts; nothing here is editable from the UI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;

function bool(value, dflt) {
  if (value === undefined || value === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, dflt, min, max, name) {
  if (value === undefined || value === '') return dflt;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${value}")`);
  }
  return n;
}

function list(value) {
  if (!value) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function httpUrl(value, name) {
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be an http(s) URL`);
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[(i += 1)];
    else out[arg.slice(2)] = 'true';
  }
  return out;
}

export function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const port = int(args.port ?? env.MRC_PORT, 8080, 0, 65535, 'MRC_PORT');
  const host = args.host ?? env.MRC_HOST ?? '127.0.0.1';
  const demo = bool(args.demo ?? env.MRC_DEMO, false);
  const dataDir = path.resolve(args.data ?? env.MRC_DATA_DIR ?? path.join(ROOT_DIR, 'data'));
  const authMode = (env.MRC_AUTH_MODE ?? 'local').toLowerCase();
  if (!['local', 'header'].includes(authMode)) throw new Error('MRC_AUTH_MODE must be "local" or "header"');
  const trustProxy = bool(env.MRC_TRUST_PROXY, false);
  if (authMode === 'header' && !trustProxy) {
    throw new Error('MRC_AUTH_MODE=header needs MRC_TRUST_PROXY=true, because the identity header is only safe behind your own proxy');
  }
  const cookieSecure = (env.MRC_COOKIE_SECURE ?? 'auto').toLowerCase();
  if (!['auto', 'true', 'false'].includes(cookieSecure)) throw new Error('MRC_COOKIE_SECURE must be auto, true or false');

  const executorWebhookUrl = httpUrl(env.MRC_EXECUTOR_WEBHOOK_URL, 'MRC_EXECUTOR_WEBHOOK_URL');
  const executorWebhookSecret = env.MRC_EXECUTOR_WEBHOOK_SECRET ?? '';
  if (executorWebhookUrl && executorWebhookSecret.length < 24) {
    throw new Error('MRC_EXECUTOR_WEBHOOK_SECRET must be at least 24 characters when MRC_EXECUTOR_WEBHOOK_URL is set');
  }
  const notifyWebhookUrl = httpUrl(env.MRC_NOTIFY_WEBHOOK_URL, 'MRC_NOTIFY_WEBHOOK_URL');
  const notifyWebhookSecret = env.MRC_NOTIFY_WEBHOOK_SECRET ?? '';

  return {
    version: APP_VERSION,
    rootDir: ROOT_DIR,
    publicDir: path.join(ROOT_DIR, 'public'),
    port,
    host,
    demo,
    dataDir,
    dbFile: env.MRC_DB_FILE ?? path.join(dataDir, 'mrc.sqlite'),
    baseUrl: httpUrl(env.MRC_BASE_URL, 'MRC_BASE_URL').replace(/\/+$/, '') || `http://localhost:${port}`,
    authMode,
    authHeader: (env.MRC_AUTH_HEADER ?? 'x-forwarded-email').toLowerCase(),
    authNameHeader: (env.MRC_AUTH_NAME_HEADER ?? 'x-forwarded-preferred-username').toLowerCase(),
    ssoAutoProvision: bool(env.MRC_SSO_AUTO_PROVISION, true),
    trustProxy,
    trustedProxies: list(env.MRC_TRUSTED_PROXIES).length ? list(env.MRC_TRUSTED_PROXIES) : ['127.0.0.1', '::1'],
    cookieSecure,
    sessionIdleMinutes: int(env.MRC_SESSION_IDLE_MINUTES, 30, 1, 1440, 'MRC_SESSION_IDLE_MINUTES'),
    sessionMaxHours: int(env.MRC_SESSION_MAX_HOURS, 12, 1, 720, 'MRC_SESSION_MAX_HOURS'),
    passwordMinLength: int(env.MRC_PASSWORD_MIN_LENGTH, 10, 8, 128, 'MRC_PASSWORD_MIN_LENGTH'),
    // scrypt work factors; tests lower N to stay fast, stored hashes carry their own parameters.
    scrypt: { N: int(env.MRC_SCRYPT_N, 32768, 1024, 1048576, 'MRC_SCRYPT_N'), r: 8, p: 3 },
    loginMaxFailures: int(env.MRC_LOGIN_MAX_FAILURES, 5, 1, 100, 'MRC_LOGIN_MAX_FAILURES'),
    loginLockMinutes: int(env.MRC_LOGIN_LOCK_MINUTES, 15, 1, 1440, 'MRC_LOGIN_LOCK_MINUTES'),
    adminLogin: env.MRC_ADMIN_LOGIN ?? 'admin',
    adminPassword: env.MRC_ADMIN_PASSWORD ?? '',
    executorWebhookUrl,
    executorWebhookSecret,
    notifyWebhookUrl,
    notifyWebhookSecret,
    sweepIntervalSeconds: int(env.MRC_SWEEP_INTERVAL_SECONDS, 300, 5, 86400, 'MRC_SWEEP_INTERVAL_SECONDS'),
    outboxIntervalSeconds: int(env.MRC_OUTBOX_INTERVAL_SECONDS, 15, 1, 3600, 'MRC_OUTBOX_INTERVAL_SECONDS'),
    logLevel: (env.MRC_LOG_LEVEL ?? 'info').toLowerCase(),
  };
}

/** Defaults for tests and embedding: in-memory database, cheap password hashing. */
export function testConfig(overrides = {}) {
  const base = loadConfig({ MRC_SCRYPT_N: '1024', MRC_LOG_LEVEL: 'silent' }, []);
  return { ...base, dbFile: ':memory:', port: 0, ...overrides };
}
