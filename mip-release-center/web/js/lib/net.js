// 서버 연결 상태.
// "연결됨"은 브라우저가 온라인이고, 센터 서버가 응답하며, 오프라인 시뮬레이션이 꺼져 있을 때다.

const SIM_KEY = 'mrc.simulateOffline';
const listeners = new Set();

const state = {
  reachable: true,
  simulated: readSimulated(),
};

function readSimulated() {
  try {
    return localStorage.getItem(SIM_KEY) === '1';
  } catch {
    return false;
  }
}

const compute = () => !state.simulated && state.reachable && navigator.onLine;
let last = compute();

export const isOnline = () => last;
export const isSimulated = () => state.simulated;

export function onNetChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 상태를 다시 계산하고, 바뀌었으면 구독자에게 알린다. */
function refresh(patch = {}) {
  Object.assign(state, patch);
  const now = compute();
  if (now === last) return;
  last = now;
  for (const listener of listeners) listener(now);
}

export const markUnreachable = () => refresh({ reachable: false });
export const markReachable = () => refresh({ reachable: true });

/** 데모용: 실제로 선을 뽑지 않고도 미연결 흐름을 확인한다. */
export function setSimulated(on) {
  try {
    localStorage.setItem(SIM_KEY, on ? '1' : '0');
  } catch {
    /* 저장하지 못해도 이번 세션에는 적용된다 */
  }
  refresh({ simulated: on });
  if (!on) checkNow();
}

export async function checkNow() {
  if (state.simulated) return false;
  try {
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    refresh({ reachable: response.ok });
  } catch {
    refresh({ reachable: false });
  }
  return last;
}

export function startMonitoring() {
  window.addEventListener('online', () => checkNow());
  window.addEventListener('offline', () => refresh());
  setInterval(checkNow, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkNow();
  });
}
