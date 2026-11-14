import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    root,
    webDir: path.join(root, 'web'),
    port: Number(env.PORT || 4300),
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    maxFileBytes: Number(env.MAX_FILE_MB || 50) * 1024 * 1024,
    releaseTtlDays: Number(env.RELEASE_TTL_DAYS || 7),
    mipAdapter: env.MIP_ADAPTER || 'mock',
    sidecarUrl: env.MIP_SIDECAR_URL || '',
    mockTenantKey: env.MOCK_TENANT_KEY || 'hanbit-demo-tenant-key',
    corpDomains: (env.CORP_DOMAINS || 'hanbit.example').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    secureCookie: env.COOKIE_SECURE === '1',
    ...overrides,
  };
}
