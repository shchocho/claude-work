// Interface language. Policy texts (label names and so on) carry their own
// translations as { ko, en } objects and go through tl().
import ko from '../locales/ko.js';
import en from '../locales/en.js';

const tables = { ko, en };
export const LOCALES = [['ko', '한국어'], ['en', 'English']];
let locale = 'ko';

export function setLocale(next) {
  locale = tables[next] ? next : 'ko';
  document.documentElement.lang = locale;
  try {
    localStorage.setItem('mrc.locale', locale);
  } catch {
    // storage may be unavailable; the choice then lasts for this page only
  }
}

export function storedLocale() {
  try {
    return localStorage.getItem('mrc.locale');
  } catch {
    return null;
  }
}

export const getLocale = () => locale;
export const has = (key) => key in tables[locale] || key in tables.ko;

export function t(key, params) {
  const template = tables[locale][key] ?? tables.ko[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined || params[name] === null ? '' : String(params[name])));
}

/** Pick the current language from a { ko, en } text object. */
export function tl(text) {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text.ko ?? text.en ?? Object.values(text)[0] ?? '';
}

const intlLocale = () => (locale === 'ko' ? 'ko-KR' : 'en-GB');

export function fmtDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intlLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function fmtDate(iso) {
  if (!iso) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso);
  return new Intl.DateTimeFormat(intlLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** "3시간 전", "in 2 days" */
export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(iso);
}

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function fmtHours(hours) {
  if (hours === null || hours === undefined) return '–';
  if (hours < 1) return t('unit.minutes', { n: Math.max(1, Math.round(hours * 60)) });
  if (hours < 48) return t('unit.hours', { n: Math.round(hours * 10) / 10 });
  return t('unit.days', { n: Math.round((hours / 24) * 10) / 10 });
}

export function fmtNumber(n) {
  return new Intl.NumberFormat(intlLocale()).format(n ?? 0);
}

/** A day picked in a date input, as the UTC instant where that local day starts / ends. */
export function dayStartIso(day) {
  if (!day) return undefined;
  const date = new Date(day + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function dayEndIso(day) {
  if (!day) return undefined;
  const date = new Date(day + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return undefined;
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}
