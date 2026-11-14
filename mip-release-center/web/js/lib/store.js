// 이 PC에 두는 저장소.
//   vault  해제한 파일 사본. 서버에 닿지 않아도 외부저장매체로 송부할 수 있게 한다.
//   queue  네트워크 미연결 중에 남긴 송부 기록. 서버에 닿으면 올려 보낸다.
// 그 밖에 화면을 오프라인에서도 그릴 수 있도록 마지막으로 받은 목록을 localStorage 에 둔다.

const DB_NAME = 'mrc';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('vault')) db.createObjectStore('vault', { keyPath: 'releaseId' });
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'clientId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(storeName, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const forUser = (items, userId) => items.filter((item) => item.userId === userId);

export const vault = {
  put: (entry) => run('vault', 'readwrite', (s) => s.put(entry)),
  get: (releaseId) => run('vault', 'readonly', (s) => s.get(releaseId)),
  list: async (userId) => forUser(await run('vault', 'readonly', (s) => s.getAll()), userId),
  remove: (releaseId) => run('vault', 'readwrite', (s) => s.delete(releaseId)),
};

export const queue = {
  put: (entry) => run('queue', 'readwrite', (s) => s.put(entry)),
  list: async (userId) =>
    forUser(await run('queue', 'readonly', (s) => s.getAll()), userId).sort((a, b) => a.sentAt.localeCompare(b.sentAt)),
  remove: (clientId) => run('queue', 'readwrite', (s) => s.delete(clientId)),
};

export const cache = {
  get(key) {
    try {
      const value = localStorage.getItem(`mrc.cache.${key}`);
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`mrc.cache.${key}`, JSON.stringify(value));
    } catch {
      /* 용량 초과 등: 캐시는 없어도 동작한다 */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(`mrc.cache.${key}`);
    } catch {
      /* 무시 */
    }
  },
};
