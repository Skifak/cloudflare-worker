/**
 * Парсеры экономического календаря для Cloudflare Worker.
 * Нормализованный формат событий — общий для FF / Investing / Myfxbook (ex-MQL5).
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CACHE_TTL = {
  default: 900,
  forexfactory: 3600,
  myfxbook: 1800
};

/** @param {number} [seconds] */
function cacheHeaders(seconds = CACHE_TTL.default) {
  return { 'Cache-Control': `public, max-age=${seconds}` };
}

const CACHE_HEADERS = cacheHeaders();

const FF_UPSTREAM_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
/** Русская локаль Investing.com — названия событий календаря на русском. */
const INVESTING_ORIGIN = 'https://ru.investing.com';
const INVESTING_CALENDAR_PAGE = `${INVESTING_ORIGIN}/economic-calendar/`;
const INVESTING_CALENDAR_API = `${INVESTING_ORIGIN}/economic-calendar/Service/getCalendarFilteredData`;
const FF_CACHE_REQUEST = new Request('https://calendar-cache.internal/forexfactory-week');
const MYFXBOOK_CACHE_REQUEST = (from, to) =>
  new Request(`https://calendar-cache.internal/myfxbook?from=${from}&to=${to}`);

/** @typedef {{ id: string; at: string; title: string; country: string; currency: string; importance: 1|2|3; forecast: string; previous: string; actual: string }} CalendarEvent */

/** @typedef {{ source: string; fetchedAt: string; events: CalendarEvent[]; error?: string; hint?: string }} CalendarPayload */

const CURRENCY_TO_COUNTRY = {
  USD: 'US',
  EUR: 'EU',
  GBP: 'GB',
  JPY: 'JP',
  AUD: 'AU',
  CAD: 'CA',
  CHF: 'CH',
  NZD: 'NZ',
  CNY: 'CN',
  SEK: 'SE',
  NOK: 'NO',
  KRW: 'KR'
};

/**
 * @param {string | null | undefined} s
 * @returns {string}
 */
export function toIsoDateOnly(s) {
  if (!s) return '';
  return String(s).slice(0, 10);
}

/**
 * @param {URLSearchParams} params
 * @returns {{ from: string; to: string }}
 */
export function resolveCalendarRange(params) {
  const week = params.get('week');
  const fromParam = params.get('from');
  const toParam = params.get('to');

  const now = new Date();
  const today = toIsoDateOnly(now.toISOString());

  if (week === 'current' || (!fromParam && !toParam)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + mondayOffset);
    const from = toIsoDateOnly(d.toISOString());
    d.setUTCDate(d.getUTCDate() + 6);
    const to = toIsoDateOnly(d.toISOString());
    return { from, to };
  }

  const from = toIsoDateOnly(fromParam);
  const to = toIsoDateOnly(toParam || fromParam);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('Invalid from/to — use YYYY-MM-DD');
  }
  if (from > to) throw new Error('from must be <= to');
  return { from, to };
}

/**
 * @param {string} impact
 * @returns {1|2|3}
 */
export function mapFfImpact(impact) {
  const s = String(impact || '').toLowerCase();
  if (s.includes('high')) return 3;
  if (s.includes('medium')) return 2;
  return 1;
}

/**
 * @param {string | number} importance
 * @returns {1|2|3}
 */
export function mapMyfxbookImpact(importance) {
  const s = String(importance || '').toLowerCase().trim();
  const n = Number(s);
  if (Number.isFinite(n) && n >= 1) return /** @type {1|2|3} */ (n >= 3 ? 3 : n >= 2 ? 2 : 1);
  if (s.includes('high')) return 3;
  if (s.includes('medium') || s.includes('med')) return 2;
  return 1;
}

/** @deprecated alias for tests / backward compat */
export const mapMql5Importance = mapMyfxbookImpact;

/**
 * @param {number} bulls
 * @returns {1|2|3}
 */
export function mapInvestingImportance(bulls) {
  if (bulls >= 3) return 3;
  if (bulls >= 2) return 2;
  return 1;
}

/**
 * @param {string} currency
 * @returns {string}
 */
export function currencyToCountry(currency) {
  const c = String(currency || '').trim().toUpperCase();
  if (!c || c === 'ALL') return '';
  return CURRENCY_TO_COUNTRY[c] || c.slice(0, 2);
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} iso
 * @returns {boolean}
 */
export function isEventInRange(from, to, iso) {
  const day = toIsoDateOnly(iso);
  return day >= from && day <= to;
}

/**
 * @param {unknown} raw
 * @param {{ from: string; to: string }} range
 * @returns {CalendarEvent[]}
 */
export function parseForexFactoryJson(raw, range) {
  if (!Array.isArray(raw)) throw new Error('ForexFactory: expected JSON array');

  /** @type {CalendarEvent[]} */
  const events = [];

  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const title = String(row.title || '').trim();
    const dateStr = String(row.date || '').trim();
    if (!title || !dateStr) continue;

    let at;
    try {
      at = new Date(dateStr).toISOString();
      if (Number.isNaN(new Date(at).getTime())) continue;
    } catch {
      continue;
    }
    if (!isEventInRange(range.from, range.to, at)) continue;

    const currency = String(row.country || '').trim().toUpperCase();
    if (currency === 'ALL') continue;

    const id = `ff:${currency}:${at}:${title}`.slice(0, 120);
    events.push({
      id,
      at,
      title,
      country: currencyToCountry(currency),
      currency,
      importance: mapFfImpact(row.impact),
      forecast: String(row.forecast ?? '').trim(),
      previous: String(row.previous ?? '').trim(),
      actual: String(row.actual ?? '').trim()
    });
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}

/**
 * @param {string} html
 * @param {{ from: string; to: string }} range
 * @returns {CalendarEvent[]}
 */
export function parseInvestingCalendarHtml(html, range) {
  /** @type {CalendarEvent[]} */
  const events = [];
  const rowRe = /<tr[^>]*id="eventRowId_(\d+)"[^>]*class="[^"]*js-event-item[^"]*"[^>]*data-event-datetime="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi;

  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const rowId = m[1];
    const dtRaw = m[2];
    const inner = m[3];

    const curMatch = inner.match(/flagCur[\s\S]*?>\s*([A-Z]{3})\s*<\/td>/i);
    const currency = (curMatch?.[1] || '').trim().toUpperCase();
    if (!currency) continue;

    const bullCount = (inner.match(/grayFullBullishIcon/g) || []).length
      || (inner.match(/bullishIcon/g) || []).length;
    const importance = mapInvestingImportance(bullCount);

    const titleMatch = inner.match(/class="[^"]*\bevent\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
      || inner.match(/class="[^"]*\bevent\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const title = (titleMatch?.[1] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;

    const actual = extractInvestingCell(inner, 'actual');
    const forecast = extractInvestingCell(inner, 'forecast');
    const previous = extractInvestingCell(inner, 'previous');

    const at = parseInvestingDatetime(dtRaw);
    if (!at || !isEventInRange(range.from, range.to, at)) continue;

    events.push({
      id: `inv:${rowId}`,
      at,
      title,
      country: currencyToCountry(currency),
      currency,
      importance,
      forecast,
      previous,
      actual
    });
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}

/**
 * @param {string} inner
 * @param {'actual'|'forecast'|'previous'} kind
 */
function extractInvestingCell(inner, kind) {
  const re = new RegExp(
    kind === 'actual'
      ? /event-\d+-actual[^>]*>([\s\S]*?)<\//i
      : new RegExp(`class="[^"]*${kind}[^"]*"[^>]*>([\\s\\S]*?)<\\/` , 'i')
  );
  const m = inner.match(re);
  return (m?.[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} raw "2026/06/09 00:30:00"
 * @returns {string | null}
 */
export function parseInvestingDatetime(raw) {
  const m = String(raw).match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {string} block
 * @param {string} tag
 */
function readXmlTag(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return (m?.[1] || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/**
 * @param {string} dateRaw "2026-06-09 13:30:00"
 * @returns {string | null}
 */
export function parseMyfxbookDatetime(dateRaw) {
  const m = String(dateRaw).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {string} xml
 * @param {{ from: string; to: string }} range
 * @returns {CalendarEvent[]}
 */
export function parseMyfxbookXml(xml, range) {
  if (!String(xml || '').includes('<')) throw new Error('Myfxbook: ожидался XML');

  /** @type {CalendarEvent[]} */
  const events = [];
  const re = /<event>([\s\S]*?)<\/event>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = readXmlTag(block, 'title');
    const currency = readXmlTag(block, 'country').toUpperCase();
    const dateRaw = readXmlTag(block, 'date');
    if (!title || !currency || !dateRaw) continue;

    const at = parseMyfxbookDatetime(dateRaw);
    if (!at || !isEventInRange(range.from, range.to, at)) continue;

    const impact = readXmlTag(block, 'impact');
    events.push({
      id: `myfxbook:${currency}:${at}:${title}`.slice(0, 120),
      at,
      title,
      country: currencyToCountry(currency),
      currency,
      importance: mapMyfxbookImpact(impact),
      forecast: readXmlTag(block, 'forecast'),
      previous: readXmlTag(block, 'previous'),
      actual: readXmlTag(block, 'actual')
    });
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      q = !q;
      continue;
    }
    if (ch === ',' && !q) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * @param {string} csv
 * @param {{ from: string; to: string }} range
 * @returns {CalendarEvent[]}
 */
export function parseMyfxbookCsv(csv, range) {
  const lines = String(csv || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name) => header.findIndex((h) => h.includes(name));

  const iDate = idx('date');
  const iTime = header.findIndex((h) => h === 'time left' || h === 'time');
  const iCur = idx('country');
  const iImp = idx('impact');
  const iTitle = idx('event');
  const iAct = idx('actual');
  const iFc = idx('forecast');
  const iPrev = idx('previous');

  if (iDate < 0 || iCur < 0 || iTitle < 0) {
    throw new Error('Myfxbook CSV: неизвестный формат заголовка');
  }

  /** @type {CalendarEvent[]} */
  const events = [];

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const title = cols[iTitle] || '';
    const currency = String(cols[iCur] || '').trim().toUpperCase();
    const datePart = cols[iDate] || '';
    const timePart = iTime >= 0 ? (cols[iTime] || '').trim() : '';
    if (!title || !currency || !datePart) continue;

    const at = parseMyfxbookCsvDatetime(datePart, timePart);
    if (!at || !isEventInRange(range.from, range.to, at)) continue;

    events.push({
      id: `myfxbook:${currency}:${at}:${title}`.slice(0, 120),
      at,
      title,
      country: currencyToCountry(currency),
      currency,
      importance: mapMyfxbookImpact(cols[iImp] || ''),
      forecast: cols[iFc] || '',
      previous: cols[iPrev] || '',
      actual: cols[iAct] || ''
    });
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}

/**
 * @param {string} datePart "Jun 09, 2026"
 * @param {string} timePart "13:30" or ""
 */
function parseMyfxbookCsvDatetime(datePart, timePart) {
  const m = String(datePart).match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const mon = months[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = 12;
  let minute = 0;
  const tm = String(timePart).match(/^(\d{1,2}):(\d{2})/);
  if (tm) {
    hour = Number(tm[1]);
    minute = Number(tm[2]);
  }
  const d = new Date(Date.UTC(year, mon, day, hour, minute, 0));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {Request} cacheRequest
 * @param {number} maxAgeMs
 * @param {boolean} [allowStale]
 */
async function readEdgeCache(cacheRequest, maxAgeMs, allowStale = false) {
  try {
    const hit = await caches.default.match(cacheRequest);
    if (!hit) return null;
    const at = hit.headers.get('X-Cached-At');
    if (at) {
      const age = Date.now() - new Date(at).getTime();
      if (age > maxAgeMs && !allowStale) return null;
    }
    return hit;
  } catch {
    return null;
  }
}

/**
 * @param {Request} cacheRequest
 * @param {string} body
 * @param {number} ttlSeconds
 */
async function writeEdgeCache(cacheRequest, body, ttlSeconds) {
  try {
    await caches.default.put(
      cacheRequest,
      new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttlSeconds}`,
          'X-Cached-At': new Date().toISOString()
        }
      })
    );
  } catch {
    /* ignore */
  }
}

/**
 * @returns {Promise<{ ok: true; body: string; stale?: boolean } | { ok: false; status: number; body?: string }>}
 */
async function fetchForexFactoryWeekJson() {
  const fresh = await readEdgeCache(FF_CACHE_REQUEST, CACHE_TTL.forexfactory * 1000);
  if (fresh) {
    const body = await fresh.text();
    if (body.trim().startsWith('[')) return { ok: true, body };
  }

  let res;
  try {
    res = await fetch(FF_UPSTREAM_URL, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }
    });
  } catch (e) {
    const stale = await readEdgeCache(FF_CACHE_REQUEST, Infinity, true);
    if (stale) {
      const body = await stale.text();
      if (body.trim().startsWith('[')) return { ok: true, body, stale: true };
    }
    throw e;
  }

  if (res.ok) {
    const body = await res.text();
    if (body.trim().startsWith('[')) {
      await writeEdgeCache(FF_CACHE_REQUEST, body, CACHE_TTL.forexfactory);
      return { ok: true, body };
    }
    return { ok: false, status: res.status, body };
  }

  if (res.status === 429) {
    const stale = await readEdgeCache(FF_CACHE_REQUEST, Infinity, true);
    if (stale) {
      const body = await stale.text();
      if (body.trim().startsWith('[')) return { ok: true, body, stale: true };
    }
  }

  return { ok: false, status: res.status };
}

/**
 * @param {string} source
 * @param {string} message
 * @param {number} [upstreamStatus]
 */
export function resolveCalendarHint(source, message, upstreamStatus) {
  const fromMsg = String(message).match(/Upstream HTTP (\d+)/);
  const code = upstreamStatus ?? (fromMsg ? Number(fromMsg[1]) : null);

  if (code === 429) {
    return 'Источник временно ограничил запросы (429). Попробуйте Investing.com или подождите 30–60 мин.';
  }
  if (code === 403) {
    return 'Источник заблокировал прокси (403). Выберите другой календарь в настройках.';
  }

  if (source === 'investing') {
    return 'Investing.com может блокировать запросы. Попробуйте Forex Factory или Myfxbook.';
  }
  if (source === 'mql5' || source === 'myfxbook') {
    return 'Myfxbook может быть недоступен. Попробуйте Investing.com.';
  }
  if (source === 'forexfactory') {
    return 'Forex Factory ограничивает частые запросы. Подождите или выберите Investing.com.';
  }
  return 'Проверьте диапазон дат или выберите другой источник.';
}

/**
 * @param {CalendarPayload} payload
 * @param {Record<string, string>} baseHeaders
 * @param {number} [ttlSeconds]
 */
export function jsonCalendarResponse(payload, baseHeaders, ttlSeconds = CACHE_TTL.default) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      ...cacheHeaders(ttlSeconds)
    }
  });
}

/**
 * @param {string} source
 * @param {string} message
 * @param {Record<string, string>} baseHeaders
 * @param {number} [status]
 * @param {number} [upstreamStatus]
 */
export function calendarErrorResponse(source, message, baseHeaders, status = 502, upstreamStatus) {
  const payload = {
    source,
    fetchedAt: new Date().toISOString(),
    events: [],
    error: message,
    hint: resolveCalendarHint(source, message, upstreamStatus)
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      ...cacheHeaders(300)
    }
  });
}

/**
 * @param {Request} request
 * @param {Record<string, string>} baseHeaders
 */
export async function handleForexFactoryCalendar(request, baseHeaders) {
  const url = new URL(request.url);
  let range;
  try {
    range = resolveCalendarRange(url.searchParams);
  } catch (e) {
    return calendarErrorResponse('forexfactory', e instanceof Error ? e.message : 'Bad range', baseHeaders, 400);
  }

  try {
    const upstream = await fetchForexFactoryWeekJson();
    if (!upstream.ok) {
      return calendarErrorResponse(
        'forexfactory',
        `Upstream HTTP ${upstream.status}`,
        baseHeaders,
        502,
        upstream.status
      );
    }

    const raw = JSON.parse(upstream.body);
    const events = parseForexFactoryJson(raw, range);
    return jsonCalendarResponse({
      source: 'forexfactory',
      fetchedAt: new Date().toISOString(),
      events,
      hint: upstream.stale
        ? 'Кэш Forex Factory (upstream 429). Данные могут быть устаревшими до 60 мин.'
        : undefined
    }, baseHeaders, CACHE_TTL.forexfactory);
  } catch (e) {
    return calendarErrorResponse(
      'forexfactory',
      e instanceof Error ? e.message : 'Fetch failed',
      baseHeaders
    );
  }
}

/**
 * @param {Request} request
 * @param {Record<string, string>} baseHeaders
 */
export async function handleInvestingCalendar(request, baseHeaders) {
  const url = new URL(request.url);
  let range;
  try {
    range = resolveCalendarRange(url.searchParams);
  } catch (e) {
    return calendarErrorResponse('investing', e instanceof Error ? e.message : 'Bad range', baseHeaders, 400);
  }

  const body = new URLSearchParams({
    dateFrom: range.from,
    dateTo: range.to,
    timeZone: '55',
    timeFilter: 'timeRemain',
    currentTab: 'custom',
    limit_from: '0',
    importance: '1,2,3'
  });

  try {
    const res = await fetch(INVESTING_CALENDAR_API, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: INVESTING_CALENDAR_PAGE,
        Origin: INVESTING_ORIGIN
      },
      body: body.toString()
    });

    if (!res.ok) {
      return calendarErrorResponse('investing', `Upstream HTTP ${res.status}`, baseHeaders, 502, res.status);
    }

    const payload = await res.json();
    const html = typeof payload?.data === 'string' ? payload.data : '';
    if (!html) {
      return calendarErrorResponse('investing', 'Пустой ответ Investing.com', baseHeaders);
    }

    const events = parseInvestingCalendarHtml(html, range);
    return jsonCalendarResponse({
      source: 'investing',
      fetchedAt: new Date().toISOString(),
      events
    }, baseHeaders);
  } catch (e) {
    return calendarErrorResponse(
      'investing',
      e instanceof Error ? e.message : 'Fetch failed',
      baseHeaders
    );
  }
}

const MYFXBOOK_CURRENCIES = 'USD,EUR,GBP,JPY,AUD,CAD,CHF,NZD';

/**
 * @param {{ from: string; to: string }} range
 */
function buildMyfxbookUrls(range) {
  const filter = `0-1-2-3_${MYFXBOOK_CURRENCIES.replace(/,/g, '-')}`;
  const common = `filter=${filter}&calPeriod=10`;
  return {
    xml: `https://www.myfxbook.com/calendar_statement.xml?start=${range.from}%2000:00&end=${range.to}%2023:59&${common}`,
    csv: `https://www.myfxbook.com/calendar_statement.csv?start=${range.from}%2000:00.0&end=${range.to}%2022:59:59.059&${common}&tabType=0`
  };
}

/**
 * Myfxbook (замена Tradays/MQL5). Маршрут /calendar/mql5 сохранён для localStorage.
 * @param {Request} request
 * @param {Record<string, string>} baseHeaders
 */
export async function handleMql5Calendar(request, baseHeaders) {
  const url = new URL(request.url);
  let range;
  try {
    range = resolveCalendarRange(url.searchParams);
  } catch (e) {
    return calendarErrorResponse('mql5', e instanceof Error ? e.message : 'Bad range', baseHeaders, 400);
  }

  const cacheReq = MYFXBOOK_CACHE_REQUEST(range.from, range.to);
  const cached = await readEdgeCache(cacheReq, CACHE_TTL.myfxbook * 1000);
  if (cached) {
    try {
      const payload = JSON.parse(await cached.text());
      if (Array.isArray(payload.events)) {
        return jsonCalendarResponse(
          {
            source: 'mql5',
            fetchedAt: payload.fetchedAt || new Date().toISOString(),
            events: payload.events
          },
          baseHeaders,
          CACHE_TTL.myfxbook
        );
      }
    } catch {
      /* refetch */
    }
  }

  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'application/xml, text/xml, text/csv, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.myfxbook.com/forex-economic-calendar',
    Origin: 'https://www.myfxbook.com'
  };

  const urls = buildMyfxbookUrls(range);

  try {
    let lastStatus = 502;
    let lastBody = '';

    for (const [kind, fetchUrl] of /** @type {const} */ ([['xml', urls.xml], ['csv', urls.csv]])) {
      const res = await fetch(fetchUrl, { headers });
      lastStatus = res.status;
      const text = await res.text();
      lastBody = text;

      if (!res.ok) continue;
      if (!text.trim() || text.includes('Just a moment')) continue;

      /** @type {CalendarEvent[]} */
      let events = [];
      try {
        events = kind === 'xml' ? parseMyfxbookXml(text, range) : parseMyfxbookCsv(text, range);
      } catch {
        continue;
      }

      if (!events.length && kind === 'xml') continue;

      const payload = {
        source: 'mql5',
        fetchedAt: new Date().toISOString(),
        events
      };
      await writeEdgeCache(
        cacheReq,
        JSON.stringify({ fetchedAt: payload.fetchedAt, events }),
        CACHE_TTL.myfxbook
      );
      return jsonCalendarResponse(payload, baseHeaders, CACHE_TTL.myfxbook);
    }

    return calendarErrorResponse(
      'mql5',
      `Upstream HTTP ${lastStatus}`,
      baseHeaders,
      502,
      lastStatus
    );
  } catch (e) {
    return calendarErrorResponse(
      'mql5',
      e instanceof Error ? e.message : 'Fetch failed',
      baseHeaders
    );
  }
}

/** Алиас для нового имени источника. */
export const handleMyfxbookCalendar = handleMql5Calendar;

export { BROWSER_UA, CACHE_HEADERS, cacheHeaders, CACHE_TTL };
