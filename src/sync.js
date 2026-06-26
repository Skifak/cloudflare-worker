/**
 * Sync-модуль: push / pull / check через KV.
 * Ключ: sync:<code>, TTL 30 дней.
 */

const CODE_RE = /^[a-z0-9]{4,16}$/;
const MAX_BODY = 5 * 1024 * 1024; // 5 MB
const TTL = 2592000; // 30 days

/**
 * @param {Record<string, string>} headers
 * @param {number} status
 * @param {object} data
 */
function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

/**
 * @param {string} code
 * @returns {string}
 */
function kvKey(code) {
  return `sync:${code}`;
}

/**
 * POST /sync/push — сохранение данных.
 * @param {Request} request
 * @param {KVNamespace} kv
 * @param {Record<string, string>} baseHeaders
 */
export async function handleSyncPush(request, kv, baseHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, baseHeaders);
  }

  const { code, data, timestamp } = body || {};

  if (!CODE_RE.test(code)) {
    return jsonResponse({ ok: false, error: 'Invalid code (4-16 lowercase alphanumeric)' }, 400, baseHeaders);
  }
  if (data === null || typeof data !== 'object') {
    return jsonResponse({ ok: false, error: 'data must be a non-null object' }, 400, baseHeaders);
  }

  const record = {
    version: 1,
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
    payload: data
  };

  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_BODY) {
    return jsonResponse({ ok: false, error: 'Payload exceeds 5 MB limit' }, 413, baseHeaders);
  }

  await kv.put(kvKey(code), serialized, { expirationTtl: TTL });

  return jsonResponse({ ok: true, timestamp: record.timestamp, sizeBytes: serialized.length }, 200, baseHeaders);
}

/**
 * GET /sync/pull?code=XXX — получение данных.
 * @param {Request} request
 * @param {KVNamespace} kv
 * @param {Record<string, string>} baseHeaders
 */
export async function handleSyncPull(request, kv, baseHeaders) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!CODE_RE.test(code)) {
    return jsonResponse({ ok: false, error: 'Invalid code (4-16 lowercase alphanumeric)' }, 400, baseHeaders);
  }

  const raw = await kv.get(kvKey(code));
  if (!raw) {
    return jsonResponse({ ok: false, error: 'Not found' }, 404, baseHeaders);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse({ ok: false, error: 'Corrupt data' }, 500, baseHeaders);
  }

  return jsonResponse({ ok: true, data: parsed.payload, timestamp: parsed.timestamp, sizeBytes: raw.length }, 200, baseHeaders);
}

/**
 * POST /sync/check — проверка существования ключа.
 * @param {Request} request
 * @param {KVNamespace} kv
 * @param {Record<string, string>} baseHeaders
 */
export async function handleSyncCheck(request, kv, baseHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, baseHeaders);
  }

  const { code } = body || {};

  if (!CODE_RE.test(code)) {
    return jsonResponse({ ok: false, error: 'Invalid code (4-16 lowercase alphanumeric)' }, 400, baseHeaders);
  }

  const meta = await kv.getWithMetadata(kvKey(code));
  if (!meta.value) {
    return jsonResponse({ ok: true, exists: false }, 200, baseHeaders);
  }

  let timestamp = 0;
  try {
    timestamp = JSON.parse(meta.value).timestamp || 0;
  } catch {
    // corrupt data — treat as not found
  }
  return jsonResponse(
    { ok: true, exists: true, timestamp, sizeBytes: meta.value.length },
    200,
    baseHeaders
  );
}

/**
 * Маршрутизация /sync/*.
 * @param {Request} request
 * @param {KVNamespace} kv
 * @param {Record<string, string>} baseHeaders
 * @returns {Promise<Response | null>}
 */
export async function handleSyncRoutes(request, kv, baseHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/sync/push' && request.method === 'POST') {
    return handleSyncPush(request, kv, baseHeaders);
  }
  if (path === '/sync/pull' && request.method === 'GET') {
    return handleSyncPull(request, kv, baseHeaders);
  }
  if (path === '/sync/check' && request.method === 'POST') {
    return handleSyncCheck(request, kv, baseHeaders);
  }

  return null;
}
