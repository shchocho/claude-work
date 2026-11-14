// MIP SDK 사이드카 어댑터.
// MIP File SDK(C++/.NET/Java)를 감싼 사내 서비스에 HTTP 로 위임한다. 계약은 README 의
// "실제 MIP SDK 연결" 절에 있다.
//
//   POST {url}/inspect    본문: 파일 바이트   → JSON (mock-adapter 의 inspect 와 같은 모양)
//   POST {url}/unprotect  본문: 파일 바이트   → 해제된 파일 바이트 + X-File-Name, Content-Type
//
// 두 요청 모두 X-File-Name(URL 인코딩)과 X-User-Email 헤더를 싣는다.

export function createSidecarAdapter({ url, fetchImpl = fetch, timeoutMs = 60_000 }) {
  if (!url) throw new Error('MIP_ADAPTER=sidecar 에는 MIP_SIDECAR_URL 이 필요합니다.');
  const base = url.replace(/\/+$/, '');

  async function call(pathname, { buffer, fileName, user }) {
    const response = await fetchImpl(`${base}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(fileName),
        'X-User-Email': user.email,
      },
      body: buffer,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let message = `MIP 사이드카가 ${response.status} 응답을 돌려주었습니다.`;
      try {
        const body = await response.json();
        if (body?.message) message = body.message;
      } catch {
        /* 본문이 JSON 이 아니면 기본 문구를 쓴다 */
      }
      throw new Error(message);
    }
    return response;
  }

  async function inspect(input) {
    const response = await call('/inspect', input);
    return response.json();
  }

  async function unprotect(input) {
    const response = await call('/unprotect', input);
    const headerName = response.headers.get('x-file-name');
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      fileName: headerName ? decodeURIComponent(headerName) : input.fileName,
      mime: response.headers.get('content-type') || 'application/octet-stream',
    };
  }

  return { name: 'sidecar', inspect, unprotect };
}
