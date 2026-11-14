import { ApiError, OfflineError, api } from './api.js';
import { isOnline, onNetChange } from './net.js';
import { cache, queue, vault } from './store.js';

// 송부 기록의 저장 경로를 정한다.
//   네트워크 연결 시   → 서버에 저장
//   네트워크 미연결 시 → 이 PC(queue)에 저장했다가, 서버에 닿으면 올려 보낸다.

const listeners = new Set();
let syncing = null;

export function onQueueChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const notify = () => {
  for (const listener of listeners) listener();
};

/** 서버에서 내 해제 문서 목록을 받는다. 서버에 닿지 않으면 마지막으로 받은 목록을 쓴다. */
export async function loadReleases(user) {
  const key = `releases.${user.id}`;
  let releases;
  let stale = false;
  let cachedAt = null;
  try {
    if (!isOnline()) throw new OfflineError();
    releases = (await api.releases()).releases;
    cache.set(key, { at: new Date().toISOString(), releases });
  } catch (error) {
    if (!(error instanceof OfflineError)) throw error;
    const cached = cache.get(key);
    releases = cached?.releases ?? [];
    cachedAt = cached?.at ?? null;
    stale = true;
  }
  const [pending, local] = await Promise.all([queue.list(user.id), vault.list(user.id)]);
  const localIds = new Set(local.map((entry) => entry.releaseId));
  const now = new Date().toISOString();
  return {
    stale,
    cachedAt,
    pending,
    releases: releases.map((release) => {
      const waiting = pending.filter((entry) => entry.meta.releaseId === release.id);
      const expired = now > release.expiresAt;
      return {
        ...release,
        canSend: !expired,
        status: release.transfers.length || waiting.length ? 'sent' : expired ? 'expired' : 'ready',
        pending: waiting,
        hasLocalCopy: localIds.has(release.id),
      };
    }),
  };
}

/**
 * 방금 해제한 문서를 PC에 받아 둔 목록에도 넣는다.
 * 문서함을 한 번도 열지 않은 채 연결이 끊겨도 그 문서를 찾아 송부할 수 있어야 한다.
 */
export function rememberRelease(user, release) {
  const key = `releases.${user.id}`;
  const cached = cache.get(key) ?? { at: new Date().toISOString(), releases: [] };
  if (cached.releases.some((r) => r.id === release.id)) return;
  cache.set(key, { ...cached, releases: [release, ...cached.releases] });
}

/** 해제 파일을 이 PC 보관함에 둔다. 이미 있으면 그대로 돌려준다. */
export async function ensureLocalCopy(user, release) {
  const existing = await vault.get(release.id);
  if (existing) return existing;
  const blob = await api.releaseFile(release.id);
  const entry = {
    releaseId: release.id,
    userId: user.id,
    code: release.code,
    fileName: release.fileName,
    mime: release.mime,
    size: blob.size,
    expiresAt: release.expiresAt,
    savedAt: new Date().toISOString(),
    blob,
  };
  await vault.put(entry);
  notify();
  return entry;
}

/**
 * 송부를 기록한다.
 * 반환: { where: 'server', transfer } 또는 { where: 'local', entry }
 * 메일 송부(G/W, 개인메일)는 서버가 보내므로 미연결이면 OfflineError 를 그대로 던진다.
 */
export async function recordTransfer(user, meta, blob) {
  const canQueue = meta.channel === 'media';
  if (isOnline()) {
    try {
      const { transfer } = await api.createTransfer(meta, canQueue ? blob : undefined);
      // 받아 둔 목록에도 이번 송부가 보이도록 조용히 새로 받는다.
      loadReleases(user).catch(() => {});
      return { where: 'server', transfer };
    } catch (error) {
      if (!(error instanceof OfflineError) || !canQueue) throw error;
    }
  } else if (!canQueue) {
    throw new OfflineError();
  }
  const sentAt = new Date().toISOString();
  const entry = {
    clientId: meta.clientId,
    userId: user.id,
    sentAt,
    fileName: meta.fileName,
    size: blob.size,
    meta: { ...meta, capturedOffline: true, sentAt },
    lastError: null,
  };
  await queue.put(entry);
  notify();
  return { where: 'local', entry };
}

/** PC에 쌓인 송부 기록을 서버로 올린다. 동시에 두 번 돌지 않는다. */
export function syncQueue(user) {
  syncing ??= (async () => {
    const result = { synced: 0, rejected: 0, remaining: 0 };
    try {
      const entries = await queue.list(user.id);
      for (const entry of entries) {
        if (!isOnline()) break;
        const copy = await vault.get(entry.meta.releaseId);
        try {
          await api.createTransfer(entry.meta, copy?.blob);
          await queue.remove(entry.clientId);
          result.synced += 1;
        } catch (error) {
          if (error instanceof OfflineError) break;
          if (!(error instanceof ApiError)) throw error;
          // 서버가 받지 않은 기록은 지우지 않고 사유와 함께 남겨 둔다.
          await queue.put({ ...entry, lastError: error.message });
          result.rejected += 1;
        }
      }
      result.remaining = (await queue.list(user.id)).length;
    } finally {
      syncing = null;
      notify();
    }
    return result;
  })();
  return syncing;
}

/** 서버에 다시 닿으면 알아서 올려 보낸다. */
export function startAutoSync(getUser, onSynced) {
  const attempt = async () => {
    const user = getUser();
    if (!user || !isOnline()) return;
    if (!(await queue.list(user.id)).length) return;
    onSynced(await syncQueue(user));
  };
  onNetChange((online) => {
    if (online) attempt();
  });
  attempt();
}
