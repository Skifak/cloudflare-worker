/**
 * Cloudflare Worker — прокси Yahoo Finance chart API, экономический календарь и OHLC.
 * GET  /yahoo/{symbol}?range=1d&interval=5m
 * GET  /calendar/{source}?from=YYYY-MM-DD&to=YYYY-MM-DD
 * POST /ohlc/request   — журнал запрашивает OHLC
 * GET  /ohlc/poll      — MQL5 Service опрашивает очередь
 * POST /ohlc/result    — MQL5 Service отдаёт бары
 * GET  /ohlc/result/:id — журнал получает результат
 * GET  /ohlc/health    — проверка здоровья
 */

import {
  handleForexFactoryCalendar,
  handleInvestingCalendar,
  handleMql5Calendar,
  calendarErrorResponse,
  BROWSER_UA
} from './calendar.js';

import {
  handleOhlcRequest,
  handleOhlcPoll,
  handleOhlcResult,
  handleOhlcResultGet,
  handleOhlcHealth
} from './ohlc.js';

import { handleSyncRoutes } from './sync.js';

const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

/** Допустимые тикеры Yahoo: SPY, ^VIX, BTC-USD, EURUSD=X */
const SYMBOL_RE = /^[\^A-Za-z0-9.\-=]{1,24}$/;

const VALID_RANGES = new Set([
  '1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'
]);

const VALID_INTERVALS = new Set([
  '1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'
]);

const CALENDAR_SOURCES = {
  forexfactory: handleForexFactoryCalendar,
  investing: handleInvestingCalendar,
  mql5: handleMql5Calendar,
  myfxbook: handleMql5Calendar
};

/**
 * @param {string | undefined} origin
 * @param {string | undefined} allowedOrigins — comma-separated list, or '*' for all
 * @returns {Record<string, string>}
 */
function corsHeaders(origin, allowedOrigins) {
  let allowOrigin = '*';
  if (allowedOrigins && allowedOrigins !== '*' && origin) {
    const list = allowedOrigins.split(',').map(s => s.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : list[0] || '*';
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

/**
 * @param {string} body
 * @param {number} status
 * @param {Record<string, string>} headers
 */
function textResponse(body, status, headers) {
  return new Response(body, { status, headers });
}

/** @param {Request} request @param {Record<string, string>} baseHeaders */
async function handleYahoo(request, baseHeaders) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/yahoo\/([^/]+)\/?$/);
  if (!match) return null;

  let symbol;
  try {
    symbol = decodeURIComponent(match[1]);
  } catch {
    return textResponse('Bad symbol encoding', 400, baseHeaders);
  }

  if (!SYMBOL_RE.test(symbol)) {
    return textResponse('Invalid symbol', 400, baseHeaders);
  }

  const range = url.searchParams.get('range') || '1d';
  const interval = url.searchParams.get('interval') || '5m';

  if (!VALID_RANGES.has(range) || !VALID_INTERVALS.has(interval)) {
    return textResponse('Invalid range or interval', 400, baseHeaders);
  }

  const yahooPath =
    `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

  let lastStatus = 502;
  for (const host of YAHOO_HOSTS) {
    try {
      const yRes = await fetch(`https://${host}${yahooPath}`, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json'
        }
      });
      if (!yRes.ok) {
        lastStatus = yRes.status;
        continue;
      }
      const body = await yRes.text();
      return new Response(body, {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      });
    } catch {
      lastStatus = 502;
    }
  }

  return textResponse('Upstream Yahoo error', lastStatus, baseHeaders);
}

/** @param {Request} request @param {Record<string, string>} baseHeaders */
async function handleCalendar(request, baseHeaders) {
  const match = new URL(request.url).pathname.match(/^\/calendar\/([^/]+)\/?$/);
  if (!match) return null;

  const source = match[1].toLowerCase();
  const handler = CALENDAR_SOURCES[/** @type {keyof typeof CALENDAR_SOURCES} */ (source)];
  if (!handler) {
    return calendarErrorResponse(source, 'Неизвестный источник календаря', baseHeaders, 404);
  }

  return handler(request, baseHeaders);
}

/**
 * Маршрутизация OHLC запросов.
 * @param {Request} request
 * @param {KVNamespace} ohlcKv
 * @param {Record<string, string>} baseHeaders
 * @returns {Promise<Response | null>}
 */
async function handleOhlcRoutes(request, ohlcKv, baseHeaders) {
  if (!ohlcKv) {
    return textResponse(
      JSON.stringify({ error: 'OHLC KV not configured' }),
      503,
      { ...baseHeaders, 'Content-Type': 'application/json' }
    );
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // GET /ohlc/health
  if (request.method === 'GET' && path === '/ohlc/health') {
    return handleOhlcHealth(ohlcKv, baseHeaders);
  }

  // POST /ohlc/request
  if (request.method === 'POST' && path === '/ohlc/request') {
    return handleOhlcRequest(request, ohlcKv, baseHeaders);
  }

  // GET /ohlc/poll
  if (request.method === 'GET' && path === '/ohlc/poll') {
    return handleOhlcPoll(ohlcKv, baseHeaders);
  }

  // POST /ohlc/result
  if (request.method === 'POST' && path === '/ohlc/result') {
    return handleOhlcResult(request, ohlcKv, baseHeaders);
  }

  // GET /ohlc/result/:requestId
  const resultMatch = path.match(/^\/ohlc\/result\/([a-z0-9]+)\/?$/);
  if (request.method === 'GET' && resultMatch) {
    return handleOhlcResultGet(resultMatch[1], ohlcKv, baseHeaders);
  }

  return null;
}

export default {
  /** @param {Request} request @param {{ CORS_ORIGIN?: string, OHLC_KV?: KVNamespace }} env */
  async fetch(request, env) {
    const baseHeaders = corsHeaders(request.headers.get('Origin'), env.CORS_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHeaders });
    }

    // OHLC routes (GET and POST)
    const ohlcRes = await handleOhlcRoutes(request, env.OHLC_KV, baseHeaders);
    if (ohlcRes) return ohlcRes;

    // Sync routes (GET and POST)
    const syncRes = await handleSyncRoutes(request, env.OHLC_KV, baseHeaders);
    if (syncRes) return syncRes;

    // GET-only routes below
    if (request.method !== 'GET') {
      return textResponse('Method Not Allowed', 405, baseHeaders);
    }

    const calendarRes = await handleCalendar(request, baseHeaders);
    if (calendarRes) return calendarRes;

    const yahooRes = await handleYahoo(request, baseHeaders);
    if (yahooRes) return yahooRes;

    return new Response(
      JSON.stringify({
        error: 'Not Found',
        hint: 'Проверьте путь: /yahoo/{symbol}, /calendar/{source}, или /ohlc/{request|poll|result|health}'
      }),
      {
        status: 404,
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
  }
};
