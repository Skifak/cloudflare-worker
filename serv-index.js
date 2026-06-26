var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/calendar.js
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
var CACHE_TTL = {
  default: 900,
  forexfactory: 3600,
  myfxbook: 1800
};
function cacheHeaders(seconds = CACHE_TTL.default) {
  return { "Cache-Control": `public, max-age=${seconds}` };
}
__name(cacheHeaders, "cacheHeaders");
var CACHE_HEADERS = cacheHeaders();
var FF_UPSTREAM_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
var INVESTING_ORIGIN = "https://ru.investing.com";
var INVESTING_CALENDAR_PAGE = `${INVESTING_ORIGIN}/economic-calendar/`;
var INVESTING_CALENDAR_API = `${INVESTING_ORIGIN}/economic-calendar/Service/getCalendarFilteredData`;
var FF_CACHE_REQUEST = new Request("https://calendar-cache.internal/forexfactory-week");
var MYFXBOOK_CACHE_REQUEST = /* @__PURE__ */ __name((from, to) => new Request(`https://calendar-cache.internal/myfxbook?from=${from}&to=${to}`), "MYFXBOOK_CACHE_REQUEST");
var CURRENCY_TO_COUNTRY = {
  USD: "US",
  EUR: "EU",
  GBP: "GB",
  JPY: "JP",
  AUD: "AU",
  CAD: "CA",
  CHF: "CH",
  NZD: "NZ",
  CNY: "CN",
  SEK: "SE",
  NOK: "NO",
  KRW: "KR"
};
function toIsoDateOnly(s) {
  if (!s) return "";
  return String(s).slice(0, 10);
}
__name(toIsoDateOnly, "toIsoDateOnly");
function resolveCalendarRange(params) {
  const week = params.get("week");
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const now = /* @__PURE__ */ new Date();
  const today = toIsoDateOnly(now.toISOString());
  if (week === "current" || !fromParam && !toParam) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + mondayOffset);
    const from2 = toIsoDateOnly(d.toISOString());
    d.setUTCDate(d.getUTCDate() + 6);
    const to2 = toIsoDateOnly(d.toISOString());
    return { from: from2, to: to2 };
  }
  const from = toIsoDateOnly(fromParam);
  const to = toIsoDateOnly(toParam || fromParam);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("Invalid from/to \u2014 use YYYY-MM-DD");
  }
  if (from > to) throw new Error("from must be <= to");
  return { from, to };
}
__name(resolveCalendarRange, "resolveCalendarRange");
function mapFfImpact(impact) {
  const s = String(impact || "").toLowerCase();
  if (s.includes("high")) return 3;
  if (s.includes("medium")) return 2;
  return 1;
}
__name(mapFfImpact, "mapFfImpact");
function mapMyfxbookImpact(importance) {
  const s = String(importance || "").toLowerCase().trim();
  const n = Number(s);
  if (Number.isFinite(n) && n >= 1) return (
    /** @type {1|2|3} */
    n >= 3 ? 3 : n >= 2 ? 2 : 1
  );
  if (s.includes("high")) return 3;
  if (s.includes("medium") || s.includes("med")) return 2;
  return 1;
}
__name(mapMyfxbookImpact, "mapMyfxbookImpact");
function mapInvestingImportance(bulls) {
  if (bulls >= 3) return 3;
  if (bulls >= 2) return 2;
  return 1;
}
__name(mapInvestingImportance, "mapInvestingImportance");
function currencyToCountry(currency) {
  const c = String(currency || "").trim().toUpperCase();
  if (!c || c === "ALL") return "";
  return CURRENCY_TO_COUNTRY[c] || c.slice(0, 2);
}
__name(currencyToCountry, "currencyToCountry");
function isEventInRange(from, to, iso) {
  const day = toIsoDateOnly(iso);
  return day >= from && day <= to;
}
__name(isEventInRange, "isEventInRange");
function parseForexFactoryJson(raw, range) {
  if (!Array.isArray(raw)) throw new Error("ForexFactory: expected JSON array");
  const events = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const title = String(row.title || "").trim();
    const dateStr = String(row.date || "").trim();
    if (!title || !dateStr) continue;
    let at;
    try {
      at = new Date(dateStr).toISOString();
      if (Number.isNaN(new Date(at).getTime())) continue;
    } catch {
      continue;
    }
    if (!isEventInRange(range.from, range.to, at)) continue;
    const currency = String(row.country || "").trim().toUpperCase();
    if (currency === "ALL") continue;
    const id = `ff:${currency}:${at}:${title}`.slice(0, 120);
    events.push({
      id,
      at,
      title,
      country: currencyToCountry(currency),
      currency,
      importance: mapFfImpact(row.impact),
      forecast: String(row.forecast ?? "").trim(),
      previous: String(row.previous ?? "").trim(),
      actual: String(row.actual ?? "").trim()
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}
__name(parseForexFactoryJson, "parseForexFactoryJson");
function parseInvestingCalendarHtml(html, range) {
  const events = [];
  const rowRe = /<tr[^>]*id="eventRowId_(\d+)"[^>]*class="[^"]*js-event-item[^"]*"[^>]*data-event-datetime="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const rowId = m[1];
    const dtRaw = m[2];
    const inner = m[3];
    const curMatch = inner.match(/flagCur[\s\S]*?>\s*([A-Z]{3})\s*<\/td>/i);
    const currency = (curMatch?.[1] || "").trim().toUpperCase();
    if (!currency) continue;
    const bullCount = (inner.match(/grayFullBullishIcon/g) || []).length || (inner.match(/bullishIcon/g) || []).length;
    const importance = mapInvestingImportance(bullCount);
    const titleMatch = inner.match(/class="[^"]*\bevent\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || inner.match(/class="[^"]*\bevent\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const title = (titleMatch?.[1] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    const actual = extractInvestingCell(inner, "actual");
    const forecast = extractInvestingCell(inner, "forecast");
    const previous = extractInvestingCell(inner, "previous");
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
__name(parseInvestingCalendarHtml, "parseInvestingCalendarHtml");
function extractInvestingCell(inner, kind) {
  const re = new RegExp(
    kind === "actual" ? /event-\d+-actual[^>]*>([\s\S]*?)<\//i : new RegExp(`class="[^"]*${kind}[^"]*"[^>]*>([\\s\\S]*?)<\\/`, "i")
  );
  const m = inner.match(re);
  return (m?.[1] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
__name(extractInvestingCell, "extractInvestingCell");
function parseInvestingDatetime(raw) {
  const m = String(raw).match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
__name(parseInvestingDatetime, "parseInvestingDatetime");
function readXmlTag(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return (m?.[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").replace(/<[^>]+>/g, "").replace(/\u00a0/g, " ").trim();
}
__name(readXmlTag, "readXmlTag");
function parseMyfxbookDatetime(dateRaw) {
  const m = String(dateRaw).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
__name(parseMyfxbookDatetime, "parseMyfxbookDatetime");
function parseMyfxbookXml(xml, range) {
  if (!String(xml || "").includes("<")) throw new Error("Myfxbook: \u043E\u0436\u0438\u0434\u0430\u043B\u0441\u044F XML");
  const events = [];
  const re = /<event>([\s\S]*?)<\/event>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = readXmlTag(block, "title");
    const currency = readXmlTag(block, "country").toUpperCase();
    const dateRaw = readXmlTag(block, "date");
    if (!title || !currency || !dateRaw) continue;
    const at = parseMyfxbookDatetime(dateRaw);
    if (!at || !isEventInRange(range.from, range.to, at)) continue;
    const impact = readXmlTag(block, "impact");
    events.push({
      id: `myfxbook:${currency}:${at}:${title}`.slice(0, 120),
      at,
      title,
      country: currencyToCountry(currency),
      currency,
      importance: mapMyfxbookImpact(impact),
      forecast: readXmlTag(block, "forecast"),
      previous: readXmlTag(block, "previous"),
      actual: readXmlTag(block, "actual")
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}
__name(parseMyfxbookXml, "parseMyfxbookXml");
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      q = !q;
      continue;
    }
    if (ch === "," && !q) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}
__name(parseCsvLine, "parseCsvLine");
function parseMyfxbookCsv(csv, range) {
  const lines = String(csv || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = /* @__PURE__ */ __name((name) => header.findIndex((h) => h.includes(name)), "idx");
  const iDate = idx("date");
  const iTime = header.findIndex((h) => h === "time left" || h === "time");
  const iCur = idx("country");
  const iImp = idx("impact");
  const iTitle = idx("event");
  const iAct = idx("actual");
  const iFc = idx("forecast");
  const iPrev = idx("previous");
  if (iDate < 0 || iCur < 0 || iTitle < 0) {
    throw new Error("Myfxbook CSV: \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430");
  }
  const events = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const title = cols[iTitle] || "";
    const currency = String(cols[iCur] || "").trim().toUpperCase();
    const datePart = cols[iDate] || "";
    const timePart = iTime >= 0 ? (cols[iTime] || "").trim() : "";
    if (!title || !currency || !datePart) continue;
    const at = parseMyfxbookCsvDatetime(datePart, timePart);
    if (!at || !isEventInRange(range.from, range.to, at)) continue;
    events.push({
      id: `myfxbook:${currency}:${at}:${title}`.slice(0, 120),
      at,
      title,
      country: currencyToCountry(currency),
      currency,
      importance: mapMyfxbookImpact(cols[iImp] || ""),
      forecast: cols[iFc] || "",
      previous: cols[iPrev] || "",
      actual: cols[iAct] || ""
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}
__name(parseMyfxbookCsv, "parseMyfxbookCsv");
function parseMyfxbookCsvDatetime(datePart, timePart) {
  const m = String(datePart).match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const months = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };
  const mon = months[m[1].toLowerCase()];
  if (mon === void 0) return null;
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
__name(parseMyfxbookCsvDatetime, "parseMyfxbookCsvDatetime");
async function readEdgeCache(cacheRequest, maxAgeMs, allowStale = false) {
  try {
    const hit = await caches.default.match(cacheRequest);
    if (!hit) return null;
    const at = hit.headers.get("X-Cached-At");
    if (at) {
      const age = Date.now() - new Date(at).getTime();
      if (age > maxAgeMs && !allowStale) return null;
    }
    return hit;
  } catch {
    return null;
  }
}
__name(readEdgeCache, "readEdgeCache");
async function writeEdgeCache(cacheRequest, body, ttlSeconds) {
  try {
    await caches.default.put(
      cacheRequest,
      new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${ttlSeconds}`,
          "X-Cached-At": (/* @__PURE__ */ new Date()).toISOString()
        }
      })
    );
  } catch {
  }
}
__name(writeEdgeCache, "writeEdgeCache");
async function fetchForexFactoryWeekJson() {
  const fresh = await readEdgeCache(FF_CACHE_REQUEST, CACHE_TTL.forexfactory * 1e3);
  if (fresh) {
    const body = await fresh.text();
    if (body.trim().startsWith("[")) return { ok: true, body };
  }
  let res;
  try {
    res = await fetch(FF_UPSTREAM_URL, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" }
    });
  } catch (e) {
    const stale = await readEdgeCache(FF_CACHE_REQUEST, Infinity, true);
    if (stale) {
      const body = await stale.text();
      if (body.trim().startsWith("[")) return { ok: true, body, stale: true };
    }
    throw e;
  }
  if (res.ok) {
    const body = await res.text();
    if (body.trim().startsWith("[")) {
      await writeEdgeCache(FF_CACHE_REQUEST, body, CACHE_TTL.forexfactory);
      return { ok: true, body };
    }
    return { ok: false, status: res.status, body };
  }
  if (res.status === 429) {
    const stale = await readEdgeCache(FF_CACHE_REQUEST, Infinity, true);
    if (stale) {
      const body = await stale.text();
      if (body.trim().startsWith("[")) return { ok: true, body, stale: true };
    }
  }
  return { ok: false, status: res.status };
}
__name(fetchForexFactoryWeekJson, "fetchForexFactoryWeekJson");
function resolveCalendarHint(source, message, upstreamStatus) {
  const fromMsg = String(message).match(/Upstream HTTP (\d+)/);
  const code = upstreamStatus ?? (fromMsg ? Number(fromMsg[1]) : null);
  if (code === 429) {
    return "\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u043B \u0437\u0430\u043F\u0440\u043E\u0441\u044B (429). \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 Investing.com \u0438\u043B\u0438 \u043F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 30\u201360 \u043C\u0438\u043D.";
  }
  if (code === 403) {
    return "\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043B \u043F\u0440\u043E\u043A\u0441\u0438 (403). \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0439 \u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u044C \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445.";
  }
  if (source === "investing") {
    return "Investing.com \u043C\u043E\u0436\u0435\u0442 \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0437\u0430\u043F\u0440\u043E\u0441\u044B. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 Forex Factory \u0438\u043B\u0438 Myfxbook.";
  }
  if (source === "mql5" || source === "myfxbook") {
    return "Myfxbook \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 Investing.com.";
  }
  if (source === "forexfactory") {
    return "Forex Factory \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u0432\u0430\u0435\u0442 \u0447\u0430\u0441\u0442\u044B\u0435 \u0437\u0430\u043F\u0440\u043E\u0441\u044B. \u041F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u0438\u043B\u0438 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 Investing.com.";
  }
  return "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D \u0434\u0430\u0442 \u0438\u043B\u0438 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0439 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A.";
}
__name(resolveCalendarHint, "resolveCalendarHint");
function jsonCalendarResponse(payload, baseHeaders, ttlSeconds = CACHE_TTL.default) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...cacheHeaders(ttlSeconds)
    }
  });
}
__name(jsonCalendarResponse, "jsonCalendarResponse");
function calendarErrorResponse(source, message, baseHeaders, status = 502, upstreamStatus) {
  const payload = {
    source,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    events: [],
    error: message,
    hint: resolveCalendarHint(source, message, upstreamStatus)
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...baseHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...cacheHeaders(300)
    }
  });
}
__name(calendarErrorResponse, "calendarErrorResponse");
async function handleForexFactoryCalendar(request, baseHeaders) {
  const url = new URL(request.url);
  let range;
  try {
    range = resolveCalendarRange(url.searchParams);
  } catch (e) {
    return calendarErrorResponse("forexfactory", e instanceof Error ? e.message : "Bad range", baseHeaders, 400);
  }
  try {
    const upstream = await fetchForexFactoryWeekJson();
    if (!upstream.ok) {
      return calendarErrorResponse(
        "forexfactory",
        `Upstream HTTP ${upstream.status}`,
        baseHeaders,
        502,
        upstream.status
      );
    }
    const raw = JSON.parse(upstream.body);
    const events = parseForexFactoryJson(raw, range);
    return jsonCalendarResponse({
      source: "forexfactory",
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      events,
      hint: upstream.stale ? "\u041A\u044D\u0448 Forex Factory (upstream 429). \u0414\u0430\u043D\u043D\u044B\u0435 \u043C\u043E\u0433\u0443\u0442 \u0431\u044B\u0442\u044C \u0443\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0438\u043C\u0438 \u0434\u043E 60 \u043C\u0438\u043D." : void 0
    }, baseHeaders, CACHE_TTL.forexfactory);
  } catch (e) {
    return calendarErrorResponse(
      "forexfactory",
      e instanceof Error ? e.message : "Fetch failed",
      baseHeaders
    );
  }
}
__name(handleForexFactoryCalendar, "handleForexFactoryCalendar");
async function handleInvestingCalendar(request, baseHeaders) {
  const url = new URL(request.url);
  let range;
  try {
    range = resolveCalendarRange(url.searchParams);
  } catch (e) {
    return calendarErrorResponse("investing", e instanceof Error ? e.message : "Bad range", baseHeaders, 400);
  }
  const body = new URLSearchParams({
    dateFrom: range.from,
    dateTo: range.to,
    timeZone: "55",
    timeFilter: "timeRemain",
    currentTab: "custom",
    limit_from: "0",
    importance: "1,2,3"
  });
  try {
    const res = await fetch(INVESTING_CALENDAR_API, {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "*/*",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Referer: INVESTING_CALENDAR_PAGE,
        Origin: INVESTING_ORIGIN
      },
      body: body.toString()
    });
    if (!res.ok) {
      return calendarErrorResponse("investing", `Upstream HTTP ${res.status}`, baseHeaders, 502, res.status);
    }
    const payload = await res.json();
    const html = typeof payload?.data === "string" ? payload.data : "";
    if (!html) {
      return calendarErrorResponse("investing", "\u041F\u0443\u0441\u0442\u043E\u0439 \u043E\u0442\u0432\u0435\u0442 Investing.com", baseHeaders);
    }
    const events = parseInvestingCalendarHtml(html, range);
    return jsonCalendarResponse({
      source: "investing",
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      events
    }, baseHeaders);
  } catch (e) {
    return calendarErrorResponse(
      "investing",
      e instanceof Error ? e.message : "Fetch failed",
      baseHeaders
    );
  }
}
__name(handleInvestingCalendar, "handleInvestingCalendar");
var MYFXBOOK_CURRENCIES = "USD,EUR,GBP,JPY,AUD,CAD,CHF,NZD";
function buildMyfxbookUrls(range) {
  const filter = `0-1-2-3_${MYFXBOOK_CURRENCIES.replace(/,/g, "-")}`;
  const common = `filter=${filter}&calPeriod=10`;
  return {
    xml: `https://www.myfxbook.com/calendar_statement.xml?start=${range.from}%2000:00&end=${range.to}%2023:59&${common}`,
    csv: `https://www.myfxbook.com/calendar_statement.csv?start=${range.from}%2000:00.0&end=${range.to}%2022:59:59.059&${common}&tabType=0`
  };
}
__name(buildMyfxbookUrls, "buildMyfxbookUrls");
async function handleMql5Calendar(request, baseHeaders) {
  const url = new URL(request.url);
  let range;
  try {
    range = resolveCalendarRange(url.searchParams);
  } catch (e) {
    return calendarErrorResponse("mql5", e instanceof Error ? e.message : "Bad range", baseHeaders, 400);
  }
  const cacheReq = MYFXBOOK_CACHE_REQUEST(range.from, range.to);
  const cached = await readEdgeCache(cacheReq, CACHE_TTL.myfxbook * 1e3);
  if (cached) {
    try {
      const payload = JSON.parse(await cached.text());
      if (Array.isArray(payload.events)) {
        return jsonCalendarResponse(
          {
            source: "mql5",
            fetchedAt: payload.fetchedAt || (/* @__PURE__ */ new Date()).toISOString(),
            events: payload.events
          },
          baseHeaders,
          CACHE_TTL.myfxbook
        );
      }
    } catch {
    }
  }
  const headers = {
    "User-Agent": BROWSER_UA,
    Accept: "application/xml, text/xml, text/csv, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.myfxbook.com/forex-economic-calendar",
    Origin: "https://www.myfxbook.com"
  };
  const urls = buildMyfxbookUrls(range);
  try {
    let lastStatus = 502;
    let lastBody = "";
    for (
      const [kind, fetchUrl] of
      /** @type {const} */
      [["xml", urls.xml], ["csv", urls.csv]]
    ) {
      const res = await fetch(fetchUrl, { headers });
      lastStatus = res.status;
      const text = await res.text();
      lastBody = text;
      if (!res.ok) continue;
      if (!text.trim() || text.includes("Just a moment")) continue;
      let events = [];
      try {
        events = kind === "xml" ? parseMyfxbookXml(text, range) : parseMyfxbookCsv(text, range);
      } catch {
        continue;
      }
      if (!events.length && kind === "xml") continue;
      const payload = {
        source: "mql5",
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
      "mql5",
      `Upstream HTTP ${lastStatus}`,
      baseHeaders,
      502,
      lastStatus
    );
  } catch (e) {
    return calendarErrorResponse(
      "mql5",
      e instanceof Error ? e.message : "Fetch failed",
      baseHeaders
    );
  }
}
__name(handleMql5Calendar, "handleMql5Calendar");

// src/ohlc.js
var REQUEST_TTL = 60;
var RESULT_TTL = 86400;
var SERVICE_TTL = 300;
var MAX_BARS = 1e4;
var VALID_INTERVALS = /* @__PURE__ */ new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mn"]);
var SYMBOL_RE = /^[A-Z0-9]{3,12}$/;
function generateRequestId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
__name(generateRequestId, "generateRequestId");
async function handleOhlcRequest(request, ohlcKv, headers) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400, headers);
  }
  const { symbol, interval, period1, period2 } = body || {};
  if (!symbol || !SYMBOL_RE.test(String(symbol).toUpperCase())) {
    return jsonError("Invalid symbol (3-12 chars, A-Z0-9)", 400, headers);
  }
  if (!interval || !VALID_INTERVALS.has(interval)) {
    return jsonError(`Invalid interval. Allowed: ${[...VALID_INTERVALS].join(", ")}`, 400, headers);
  }
  if (!period1 || !period2 || period1 >= period2) {
    return jsonError("Invalid period1/period2 (epoch seconds, period1 < period2)", 400, headers);
  }
  const requestId = generateRequestId();
  const requestKey = `req:${requestId}`;
  const day1 = Math.floor(period1 / 86400);
  const day2 = Math.ceil(period2 / 86400);
  const cacheKey = `cache:${String(symbol).toUpperCase()}:${interval}:${day1}:${day2}`;
  const cached = await ohlcKv.get(cacheKey, { type: "json" });
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
__name(handleOhlcRequest, "handleOhlcRequest");
async function handleOhlcPoll(ohlcKv, headers) {
  const list = await ohlcKv.list({ prefix: "req:", limit: 1 });
  if (!list.keys.length) {
    return jsonResponse({}, 200, headers);
  }
  const key = list.keys[0];
  const request = await ohlcKv.get(key.name, { type: "json" });
  if (!request) {
    return jsonResponse({}, 200, headers);
  }
  const svcKey = `svc:${request.symbol}`;
  await ohlcKv.put(svcKey, JSON.stringify({ lastPoll: Date.now() }), { expirationTtl: SERVICE_TTL });
  return jsonResponse(request, 200, headers);
}
__name(handleOhlcPoll, "handleOhlcPoll");
async function handleOhlcResult(request, ohlcKv, headers) {
  let body;
  try {
    const text = await request.text();
    body = JSON.parse(text.replace(/\0/g, ""));
  } catch {
    return jsonError("Invalid JSON", 400, headers);
  }
  const { requestId, bars } = body || {};
  if (!requestId || typeof requestId !== "string") {
    return jsonError("Missing requestId", 400, headers);
  }
  if (!Array.isArray(bars)) {
    return jsonError("Missing or invalid bars array", 400, headers);
  }
  const requestKey = `req:${requestId}`;
  const resultKey = `res:${requestId}`;
  const existingRequest = await ohlcKv.get(requestKey, { type: "json" });
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
__name(handleOhlcResult, "handleOhlcResult");
async function handleOhlcResultGet(requestId, ohlcKv, headers) {
  if (!requestId || typeof requestId !== "string") {
    return jsonError("Invalid requestId", 400, headers);
  }
  const key = `res:${requestId}`;
  const data = await ohlcKv.get(key, { type: "json" });
  if (!data || !data.bars) {
    return jsonResponse({ requestId, pending: true, bars: [] }, 200, headers);
  }
  return jsonResponse({ requestId, bars: data.bars }, 200, headers);
}
__name(handleOhlcResultGet, "handleOhlcResultGet");
async function handleOhlcHealth(ohlcKv, headers) {
  const svcList = await ohlcKv.list({ prefix: "svc:", limit: 10 });
  const services = [];
  for (const key of svcList.keys) {
    const svc = await ohlcKv.get(key.name, { type: "json" });
    if (svc) {
      const symbol = key.name.replace("svc:", "");
      const age = Date.now() - svc.lastPoll;
      services.push({
        symbol,
        lastPoll: new Date(svc.lastPoll).toISOString(),
        ageSeconds: Math.floor(age / 1e3),
        active: age < SERVICE_TTL * 1e3
      });
    }
  }
  const pendingList = await ohlcKv.list({ prefix: "req:", limit: 100 });
  const pendingCount = pendingList.keys.length;
  return jsonResponse({
    status: "ok",
    services,
    pendingRequests: pendingCount,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  }, 200, headers);
}
__name(handleOhlcHealth, "handleOhlcHealth");
function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
__name(jsonResponse, "jsonResponse");
function jsonError(message, status, headers) {
  return jsonResponse({ error: message }, status, headers);
}
__name(jsonError, "jsonError");

// src/sync.js
var CODE_RE = /^[a-z0-9]{4,16}$/;
var MAX_BODY = 5 * 1024 * 1024;
var TTL = 2592e3;
function jsonResponse2(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
__name(jsonResponse2, "jsonResponse");
function kvKey(code) {
  return `sync:${code}`;
}
__name(kvKey, "kvKey");
async function handleSyncPush(request, kv, baseHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse2({ ok: false, error: "Invalid JSON" }, 400, baseHeaders);
  }
  const { code, data, timestamp } = body || {};
  if (!CODE_RE.test(code)) {
    return jsonResponse2({ ok: false, error: "Invalid code (4-16 lowercase alphanumeric)" }, 400, baseHeaders);
  }
  if (data === null || typeof data !== "object") {
    return jsonResponse2({ ok: false, error: "data must be a non-null object" }, 400, baseHeaders);
  }
  const record = {
    version: 1,
    timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
    payload: data
  };
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_BODY) {
    return jsonResponse2({ ok: false, error: "Payload exceeds 5 MB limit" }, 413, baseHeaders);
  }
  await kv.put(kvKey(code), serialized, { expirationTtl: TTL });
  return jsonResponse2({ ok: true, timestamp: record.timestamp, sizeBytes: serialized.length }, 200, baseHeaders);
}
__name(handleSyncPush, "handleSyncPush");
async function handleSyncPull(request, kv, baseHeaders) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!CODE_RE.test(code)) {
    return jsonResponse2({ ok: false, error: "Invalid code (4-16 lowercase alphanumeric)" }, 400, baseHeaders);
  }
  const raw = await kv.get(kvKey(code));
  if (!raw) {
    return jsonResponse2({ ok: false, error: "Not found" }, 404, baseHeaders);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse2({ ok: false, error: "Corrupt data" }, 500, baseHeaders);
  }
  return jsonResponse2({ ok: true, data: parsed.payload, timestamp: parsed.timestamp, sizeBytes: raw.length }, 200, baseHeaders);
}
__name(handleSyncPull, "handleSyncPull");
async function handleSyncCheck(request, kv, baseHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse2({ ok: false, error: "Invalid JSON" }, 400, baseHeaders);
  }
  const { code } = body || {};
  if (!CODE_RE.test(code)) {
    return jsonResponse2({ ok: false, error: "Invalid code (4-16 lowercase alphanumeric)" }, 400, baseHeaders);
  }
  const meta = await kv.getWithMetadata(kvKey(code));
  if (!meta.value) {
    return jsonResponse2({ ok: true, exists: false }, 200, baseHeaders);
  }
  let timestamp = 0;
  try {
    timestamp = JSON.parse(meta.value).timestamp || 0;
  } catch {
  }
  return jsonResponse2(
    { ok: true, exists: true, timestamp, sizeBytes: meta.value.length },
    200,
    baseHeaders
  );
}
__name(handleSyncCheck, "handleSyncCheck");
async function handleSyncRoutes(request, kv, baseHeaders) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/sync/push" && request.method === "POST") {
    return handleSyncPush(request, kv, baseHeaders);
  }
  if (path === "/sync/pull" && request.method === "GET") {
    return handleSyncPull(request, kv, baseHeaders);
  }
  if (path === "/sync/check" && request.method === "POST") {
    return handleSyncCheck(request, kv, baseHeaders);
  }
  return null;
}
__name(handleSyncRoutes, "handleSyncRoutes");

// src/index.js
var YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
var SYMBOL_RE2 = /^[\^A-Za-z0-9.\-=]{1,24}$/;
var VALID_RANGES = /* @__PURE__ */ new Set([
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max"
]);
var VALID_INTERVALS2 = /* @__PURE__ */ new Set([
  "1m",
  "2m",
  "5m",
  "15m",
  "30m",
  "60m",
  "90m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo"
]);
var CALENDAR_SOURCES = {
  forexfactory: handleForexFactoryCalendar,
  investing: handleInvestingCalendar,
  mql5: handleMql5Calendar,
  myfxbook: handleMql5Calendar
};
function corsHeaders(origin, allowedOrigins) {
  let allowOrigin = "*";
  if (allowedOrigins && allowedOrigins !== "*" && origin) {
    const list = allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : list[0] || "*";
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHeaders, "corsHeaders");
function textResponse(body, status, headers) {
  return new Response(body, { status, headers });
}
__name(textResponse, "textResponse");
async function handleYahoo(request, baseHeaders) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/yahoo\/([^/]+)\/?$/);
  if (!match) return null;
  let symbol;
  try {
    symbol = decodeURIComponent(match[1]);
  } catch {
    return textResponse("Bad symbol encoding", 400, baseHeaders);
  }
  if (!SYMBOL_RE2.test(symbol)) {
    return textResponse("Invalid symbol", 400, baseHeaders);
  }
  const range = url.searchParams.get("range") || "1d";
  const interval = url.searchParams.get("interval") || "5m";
  if (!VALID_RANGES.has(range) || !VALID_INTERVALS2.has(interval)) {
    return textResponse("Invalid range or interval", 400, baseHeaders);
  }
  const yahooPath = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  let lastStatus = 502;
  for (const host of YAHOO_HOSTS) {
    try {
      const yRes = await fetch(`https://${host}${yahooPath}`, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json"
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
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300"
        }
      });
    } catch {
      lastStatus = 502;
    }
  }
  return textResponse("Upstream Yahoo error", lastStatus, baseHeaders);
}
__name(handleYahoo, "handleYahoo");
async function handleCalendar(request, baseHeaders) {
  const match = new URL(request.url).pathname.match(/^\/calendar\/([^/]+)\/?$/);
  if (!match) return null;
  const source = match[1].toLowerCase();
  const handler = CALENDAR_SOURCES[
    /** @type {keyof typeof CALENDAR_SOURCES} */
    source
  ];
  if (!handler) {
    return calendarErrorResponse(source, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u044F", baseHeaders, 404);
  }
  return handler(request, baseHeaders);
}
__name(handleCalendar, "handleCalendar");
async function handleOhlcRoutes(request, ohlcKv, baseHeaders) {
  if (!ohlcKv) {
    return textResponse(
      JSON.stringify({ error: "OHLC KV not configured" }),
      503,
      { ...baseHeaders, "Content-Type": "application/json" }
    );
  }
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/ohlc/health") {
    return handleOhlcHealth(ohlcKv, baseHeaders);
  }
  if (request.method === "POST" && path === "/ohlc/request") {
    return handleOhlcRequest(request, ohlcKv, baseHeaders);
  }
  if (request.method === "GET" && path === "/ohlc/poll") {
    return handleOhlcPoll(ohlcKv, baseHeaders);
  }
  if (request.method === "POST" && path === "/ohlc/result") {
    return handleOhlcResult(request, ohlcKv, baseHeaders);
  }
  const resultMatch = path.match(/^\/ohlc\/result\/([a-z0-9]+)\/?$/);
  if (request.method === "GET" && resultMatch) {
    return handleOhlcResultGet(resultMatch[1], ohlcKv, baseHeaders);
  }
  return null;
}
__name(handleOhlcRoutes, "handleOhlcRoutes");
var index_default = {
  /** @param {Request} request @param {{ CORS_ORIGIN?: string, OHLC_KV?: KVNamespace }} env */
  async fetch(request, env) {
    const baseHeaders = corsHeaders(request.headers.get("Origin"), env.CORS_ORIGIN);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders });
    }
    const ohlcRes = await handleOhlcRoutes(request, env.OHLC_KV, baseHeaders);
    if (ohlcRes) return ohlcRes;
    const syncRes = await handleSyncRoutes(request, env.OHLC_KV, baseHeaders);
    if (syncRes) return syncRes;
    if (request.method !== "GET") {
      return textResponse("Method Not Allowed", 405, baseHeaders);
    }
    const calendarRes = await handleCalendar(request, baseHeaders);
    if (calendarRes) return calendarRes;
    const yahooRes = await handleYahoo(request, baseHeaders);
    if (yahooRes) return yahooRes;
    return new Response(
      JSON.stringify({
        error: "Not Found",
        hint: "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u0443\u0442\u044C: /yahoo/{symbol}, /calendar/{source}, \u0438\u043B\u0438 /ohlc/{request|poll|result|health}"
      }),
      {
        status: 404,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    );
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
