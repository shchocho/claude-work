// Maintenance commands that work directly on the database file.
//   node server/cli.js <command> [--option value]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from './config.js';
import { openDatabase } from './db.js';
import { createApp, createLogger } from './app.js';
import { seedDemo, DEMO_PASSWORD } from './seed.js';
import { ROLES } from './rbac.js';
import { toCsv } from './util.js';

const USAGE = `Usage: node server/cli.js <command> [options]

  user:create --login <id> --name <name> [--roles admin,security] [--email <email>]
        Create an account. A temporary password is printed once.
  user:reset-password --login <id>
        Set a new temporary password and sign the user out everywhere.
  user:list
        Show every account with its roles.
  audit:verify
        Check the audit trail's hash chain from the first entry to the last.
  audit:export --out <file> [--format jsonl|csv]
        Write the whole audit trail to a file.
  backup --out <file>
        Write a consistent copy of the database to a new file.
  seed:demo
        Fill an empty database with the demo organisation.

Settings come from the same MRC_* environment variables (and .env) as the server.`;

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = true;
    else out[argv[i].slice(2)] = argv[(i += 1)];
  }
  return out;
}

function need(opts, name) {
  if (typeof opts[name] !== 'string' || !opts[name]) throw new Error(`Missing --${name}`);
  return opts[name];
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help') {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const opts = options(rest);
const config = loadConfig(process.env, []);
const db = openDatabase(config.dbFile);
const app = createApp({ config, db, logger: createLogger('warn') });
const { users, audit } = app.services;
const actor = { type: 'system', id: null, label: 'cli', ip: null };
let exitCode = 0;

try {
  if (command === 'user:create') {
    const roles = typeof opts.roles === 'string' ? opts.roles.split(',').map((r) => r.trim()).filter(Boolean) : ['requester'];
    const unknown = roles.filter((r) => !ROLES.includes(r));
    if (unknown.length) throw new Error(`Unknown role(s): ${unknown.join(', ')}. Known roles: ${ROLES.join(', ')}`);
    const { user, temporaryPassword } = await users.create(actor, { login: need(opts, 'login'), name: need(opts, 'name'), email: typeof opts.email === 'string' ? opts.email : '', roles });
    console.log(`Created ${user.login} (${user.roles.join(', ')})`);
    console.log(`Temporary password: ${temporaryPassword}`);
  } else if (command === 'user:reset-password') {
    const row = users.rowByLogin(need(opts, 'login'));
    if (!row) throw new Error('No such user');
    const { temporaryPassword } = await users.resetPassword(actor, row.id);
    console.log(`Temporary password for ${row.login}: ${temporaryPassword}`);
  } else if (command === 'user:list') {
    for (const user of users.list({ pageSize: 200 }).items) {
      console.log(`${user.active ? ' ' : 'x'} ${user.login.padEnd(28)} ${user.name.padEnd(16)} ${user.roles.join(',')}`);
    }
  } else if (command === 'audit:verify') {
    const result = audit.verify();
    if (result.ok) console.log(`OK: ${result.count} entries, head hash ${result.headHash}`);
    else {
      console.error(`BROKEN at entry ${result.brokenAt} (${result.problem}); ${result.count} entries before it are intact`);
      exitCode = 2;
    }
  } else if (command === 'audit:export') {
    const out = path.resolve(need(opts, 'out'));
    const rows = audit.exportRows({}, Number.MAX_SAFE_INTEGER);
    if (opts.format === 'csv') {
      const columns = ['seq', 'ts', 'actorType', 'actorId', 'actorLabel', 'action', 'entityType', 'entityId', 'requestId', 'ip', 'details', 'prevHash', 'hash']
        .map((key) => ({ header: key, value: (r) => r[key] }));
      fs.writeFileSync(out, toCsv(columns, rows));
    } else fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    audit.append(actor, 'audit.exported', { details: { format: opts.format === 'csv' ? 'csv' : 'jsonl', count: rows.length, via: 'cli' } });
    console.log(`Wrote ${rows.length} entries to ${out}`);
  } else if (command === 'backup') {
    const out = path.resolve(need(opts, 'out'));
    db.backupTo(out);
    console.log(`Backup written to ${out}`);
  } else if (command === 'seed:demo') {
    const seeded = await seedDemo(app);
    if (!seeded) throw new Error('The database already has users; demo data is only added to an empty database');
    console.log(`Demo data created: ${seeded.users} accounts, password "${DEMO_PASSWORD}"`);
  } else {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    exitCode = 1;
  }
} catch (err) {
  const details = err.details ? ' ' + JSON.stringify(err.details) : '';
  console.error(`Error: ${err.message}${details}`);
  exitCode = 1;
} finally {
  db.close();
}
process.exit(exitCode);
