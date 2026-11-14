import { isSimulated, markReachable, markUnreachable } from './net.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 서버에 닿지 못했다(네트워크 미연결). 서버가 거절한 것과 구분한다. */
export class OfflineError extends Error {
  constructor() {
    super('서버에 연결할 수 없습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.');
  }
}

let onUnauthenticated = () => {};
export const setUnauthenticatedHandler = (fn) => {
  onUnauthenticated = fn;
};

/** 메타데이터와 파일을 한 본문에 담는다: [4바이트 길이][메타 JSON][파일] */
export function frame(meta, blob) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const length = new DataView(new ArrayBuffer(4));
  length.setUint32(0, json.length);
  return new Blob(blob ? [length, json, blob] : [length, json], { type: 'application/octet-stream' });
}

async function request(method, url, { body } = {}) {
  if (isSimulated()) throw new OfflineError();
  let response;
  try {
    response = await fetch(url, {
      method,
      body,
      headers: method === 'GET' ? {} : { 'X-MRC-Client': '1' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    markUnreachable();
    throw new OfflineError();
  }
  markReachable();
  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* JSON 이 아닌 오류 응답 */
    }
    const error = new ApiError(
      response.status,
      payload?.error?.code ?? 'UNKNOWN',
      payload?.error?.message ?? '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    );
    if (response.status === 401) onUnauthenticated();
    throw error;
  }
  return response;
}

const getJson = async (url) => (await request('GET', url)).json();
const postJson = async (url, data) => (await request('POST', url, { body: JSON.stringify(data) })).json();
const postFramed = async (url, meta, blob) => (await request('POST', url, { body: frame(meta, blob) })).json();
const query = (params) => {
  const usp = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  const s = usp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  meta: () => getJson('/api/meta'),
  users: () => getJson('/api/users'),
  session: () => getJson('/api/session'),
  login: (userId) => postJson('/api/session', { userId }),
  logout: () => request('DELETE', '/api/session'),
  samples: () => getJson('/api/samples'),
  sampleFile: async (id) => (await request('GET', `/api/samples/${encodeURIComponent(id)}`)).blob(),
  inspect: (file) => postFramed('/api/inspect', { fileName: file.name }, file),
  createRelease: (meta, file) => postFramed('/api/releases', meta, file),
  releases: () => getJson('/api/releases'),
  releaseFile: async (id) => (await request('GET', `/api/releases/${encodeURIComponent(id)}/file`)).blob(),
  createTransfer: (meta, blob) => postFramed('/api/transfers', meta, blob),
  audit: {
    stats: () => getJson('/api/audit/stats'),
    transfers: (filters = {}) => getJson(`/api/audit/transfers${query(filters)}`),
    releases: (filters = {}) => getJson(`/api/audit/releases${query(filters)}`),
    events: () => getJson('/api/audit/events'),
    verify: () => getJson('/api/audit/verify'),
    review: (id, data) => postJson(`/api/audit/transfers/${encodeURIComponent(id)}/review`, data),
    file: async (kind, id) => (await request('GET', `/api/audit/${kind}s/${encodeURIComponent(id)}/file`)).blob(),
    exportCsv: async (filters = {}) => (await request('GET', `/api/audit/export.csv${query(filters)}`)).blob(),
  },
};
