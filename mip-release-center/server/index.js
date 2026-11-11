// Entry point: load settings, open the database, start the HTTP server.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from './config.js';
import { openDatabase } from './db.js';
import { createApp, createLogger } from './app.js';
import { ensureAdmin, seedDemo, DEMO_PASSWORD } from './seed.js';

const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const db = openDatabase(config.dbFile);
const app = createApp({ config, db, logger });

if (config.demo) {
  const seeded = await seedDemo(app);
  if (seeded) console.log(`Demo data created: ${seeded.users} accounts, all with the password "${DEMO_PASSWORD}".`);
} else {
  await ensureAdmin(app);
}

const server = http.createServer((req, res) => {
  app.handle(req, res).catch((err) => {
    logger.error('unhandled request error', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

server.listen(config.port, config.host, () => {
  const { address, port } = server.address();
  const shown = address.includes(':') ? `[${address}]` : address;
  app.start();
  console.log(`MIP Release Center ${config.version} listening on http://${shown}:${port}`);
  if (config.demo) {
    console.log('DEMO MODE: sample accounts share one published password and the simulated executor is available.');
    console.log('Never expose a demo instance to a network you do not control.');
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1' && config.cookieSecure === 'auto' && !config.trustProxy) {
    console.log('Note: serving beyond localhost over plain HTTP. Put this behind HTTPS (see README) before real use.');
  }
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info(`received ${signal}, shutting down`);
  app.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
