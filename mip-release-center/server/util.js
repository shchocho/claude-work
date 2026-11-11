// Small shared helpers: ids, hashing, canonical JSON, time, CSV.
import crypto from 'node:crypto';

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmacHex(secret, input) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

/** Constant-time string comparison that does not leak length through timing. */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** JSON with recursively sorted keys, so the same value always hashes the same. */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function iso(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

export function addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 3600_000);
}

export function addDays(date, days) {
  return addHours(date, days * 24);
}

export function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60_000);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Escape a user string for use inside a LIKE pattern (with ESCAPE '\'). */
export function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (m) => '\\' + m);
}

export function clampInt(value, dflt, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * CSV for spreadsheet users: UTF-8 with BOM (Excel on Korean Windows otherwise
 * reads it as CP949), CRLF line ends, and a leading apostrophe on cells that a
 * spreadsheet would treat as a formula.
 */
export function toCsv(columns, rows) {
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    let s = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function uniq(list) {
  return [...new Set(list)];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
