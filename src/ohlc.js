/**
 * OHLC proxy через Cloudflare KV.
 *
 * Flow:
 *   1. Journal → POST /ohlc/request { symbol, interval, period1, period2 }
 *      → KV: req:{uuid} = request, TTL 60s → returns { requestId }
 *   2. MQL5 Service → GET /ohlc/poll
 *      → returns next pending request or {}
 *   3. MQL5 Service → POST /ohlc/result { requestId, bars[] }
 *      → KV: res:{requestId} = bars, TTL 1h; del req:{requestId}
 *   4. Journal → GET /ohlc/result/:requestId
 *      → returns { bars[] } or 404 (not ready)
 */

const REQUEST_TTL = 60;
const RESULT_TTL = 86400;
const SERVICE_TTL = 300;
const MAX_BARS = 10000;

const VALID_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mn']);
const SYMBOL_RE = /^[A-Z0-9]{3,12}$/;

function generateRequestId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export async function handleOhlcRequest(request, ohlcKv, headers) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON', 400, headers);
  }

  const { symbol, interval, period1, period2 } = body || {};

  if (!symbol || !SYMBOL_RE.test(String(symbol).toUpperCase())) {
    return jsonError('Invalid symbol (3-12 chars, A-Z0-9)', 400, headers);
  }
  if (!interval || !VALID_INTERVALS.has(interval)) {
    return jsonError(`Invalid interval. Allowed: ${[...VALID_INTERVALS].join(', ')}`, 400, headers);
  }
  if (!period1 || !period2 || period1 >= period2) {
    return jsonError('Invalid period1/period2 (epoch seconds, period1 < period2)', 400, headers);
  }

  const requestId = generateRequestId();
  const requestKey = `req:${requestId}`;
  const day1 = Math.floor(period1 / 86400);
  const day2 = Math.ceil(period2 / 86400);
  const cacheKey = `cache:${String(symbol).toUpperCase()}:${interval}:${day1}:${day2}`;

  const cached = await ohlcKv.get(cacheKey, { type: 'json' });
  if (cached) {
    return jsonResponse({ requestId, bars: cached, cached: true }, 200, headers);
  }

  const requestPayload = {
    requestId,
    symbol: String(symbol).toUpperCase(),
    interval,
    period1: Number(period1),
    period2: Number(period2),
    createdAt: Date.now()
  };

  await ohlcKv.put(requestKey, JSON.stringify(requestPayload), { expirationTtl: REQUEST_TTL });

  return jsonResponse({ requestId, queued: true }, 202, headers);
}

export async function handleOhlcPoll(ohlcKv, headers) {
  const list = await ohlcKv.list({ prefix: 'req:', limit: 1 });

  if (!list.keys.length) {
    return jsonResponse({}, 200, headers);
  }

  const key = list.keys[0];
  const request = await ohlcKv.get(key.name, { type: 'json' });

  if (!request) {
    return jsonResponse({}, 200, headers);
  }

  const svcKey = `svc:${request.symbol}`;
  await ohlcKv.put(svcKey, JSON.stringify({ lastPoll: Date.now() }), { expirationTtl: SERVICE_TTL });

  return jsonResponse(request, 200, headers);
}

export async function handleOhlcResult(request, ohlcKv, headers) {
  let body;
  try {
    const text = await request.text();
    body = JSON.parse(text.replace(/\0/g, ''));
  } catch {
    return jsonError('Invalid JSON', 400, headers);
  }

  const { requestId, bars } = body || {};

  if (!requestId || typeof requestId !== 'string') {
    return jsonError('Missing requestId', 400, headers);
  }
  if (!Array.isArray(bars)) {
    return jsonError('Missing or invalid bars array', 400, headers);
  }

  const requestKey = `req:${requestId}`;
  const resultKey = `res:${requestId}`;
  const existingRequest = await ohlcKv.get(requestKey, { type: 'json' });

  const limitedBars = bars.slice(0, MAX_BARS);
  await ohlcKv.put(resultKey, JSON.stringify({ requestId, bars: limitedBars }), { expirationTtl: RESULT_TTL });

  if (existingRequest) {
    await ohlcKv.delete(requestKey);
    const day1 = Math.floor(existingRequest.period1 / 86400);
    const day2 = Math.ceil(existingRequest.period2 / 86400);
    const cacheKey = `cache:${existingRequest.symbol}:${existingRequest.interval}:${day1}:${day2}`;
    await ohlcKv.put(cacheKey, JSON.stringify(limitedBars), { expirationTtl: RESULT_TTL });
  }

  return jsonResponse({ ok: true, barsCount: limitedBars.length }, 200, headers);
}

export async function handleOhlcResultGet(requestId, ohlcKv, headers) {
  if (!requestId || typeof requestId !== 'string') {
    return jsonError('Invalid requestId', 400, headers);
  }

  const key = `res:${requestId}`;
  const data = await ohlcKv.get(key, { type: 'json' });

  if (!data || !data.bars) {
    return jsonResponse({ requestId, pending: true, bars: [] }, 200, headers);
  }

  return jsonResponse({ requestId, bars: data.bars }, 200, headers);
}

export async function handleOhlcHealth(ohlcKv, headers) {
  const svcList = await ohlcKv.list({ prefix: 'svc:', limit: 10 });
  const services = [];

  for (const key of svcList.keys) {
    const svc = await ohlcKv.get(key.name, { type: 'json' });
    if (svc) {
      const symbol = key.name.replace('svc:', '');
      const age = Date.now() - svc.lastPoll;
      services.push({
        symbol,
        lastPoll: new Date(svc.lastPoll).toISOString(),
        ageSeconds: Math.floor(age / 1000),
        active: age < SERVICE_TTL * 1000
      });
    }
  }

  const pendingList = await ohlcKv.list({ prefix: 'req:', limit: 100 });
  const pendingCount = pendingList.keys.length;

  return jsonResponse({
    status: 'ok',
    services,
    pendingRequests: pendingCount,
    timestamp: new Date().toISOString()
  }, 200, headers);
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

function jsonError(message, status, headers) {
  return jsonResponse({ error: message }, status, headers);
}

export { VALID_INTERVALS, SYMBOL_RE, REQUEST_TTL, RESULT_TTL, SERVICE_TTL };
