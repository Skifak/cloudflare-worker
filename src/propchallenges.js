/**
 * Парсер проп-челленджей и проп-фирм.
 * Извлекает челленджи, брокеров и профили фирм из SSR-рендеринга Next.js.
 */

import { BROWSER_UA } from './calendar.js';

const CTRADER_CHALLENGES_URL = 'https://ctrader.com/prop-challenges';
const CTRADER_FIRMS_URL = 'https://ctrader.com/prop-firms';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

/** @type {{ data: { challenges: any[]; brokers: any[]; firms: any[] }; fetchedAt: number } | null} */
let cache = null;

/**
 * @param {Record<string, string>} baseHeaders
 * @param {number} [status]
 * @param {string} [message]
 */
function errorResponse(baseHeaders, status = 502, message = 'Upstream cTrader error') {
  return new Response(
    JSON.stringify({ error: message, fetchedAt: new Date().toISOString() }),
    {
      status,
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json; charset=utf-8'
      }
    }
  );
}

/**
 * Извлекает __NEXT_DATA__ из HTML-страницы
 * @param {string} html
 * @returns {object | null}
 */
function extractNextData(html) {
  const match = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Загружает страницу и извлекает данные из __NEXT_DATA__
 * @param {string} url
 * @returns {Promise<object | null>}
 */
async function fetchPageData(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractNextData(html);
  } catch {
    return null;
  }
}

/**
 * @param {Request} request
 * @param {Record<string, string>} baseHeaders
 */
export async function handlePropChallenges(request, baseHeaders) {
  const url = new URL(request.url);
  if (url.pathname !== '/prop-challenges') return null;

  // Проверка кэша
  if (cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
    return new Response(
      JSON.stringify({
        challenges: cache.data.challenges,
        brokers: cache.data.brokers,
        firms: cache.data.firms,
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        cached: true
      }),
      {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      }
    );
  }

  // Загружаем обе страницы параллельно
  const [challengesNextData, firmsNextData] = await Promise.all([
    fetchPageData(CTRADER_CHALLENGES_URL),
    fetchPageData(CTRADER_FIRMS_URL)
  ]);

  if (!challengesNextData && !firmsNextData) {
    return errorResponse(baseHeaders, 502, 'Both upstream pages failed to load');
  }

  // --- Челленджи и брокеры ---
  const challengesPageProps = challengesNextData?.props?.pageProps;
  const challengesRedux = challengesPageProps?.__PRELOADED_STATE__
    || challengesPageProps?.initialState
    || challengesPageProps;

  const challenges = challengesRedux?.challengeList?.data || [];
  const brokers = challengesRedux?.brokerList?.data || [];

  // --- Профили фирм ---
  const firmsPageProps = firmsNextData?.props?.pageProps;
  const firmsRedux = firmsPageProps?.__PRELOADED_STATE__
    || firmsPageProps?.initialState
    || firmsPageProps;

  const firms = firmsRedux?.propFirmList?.data || [];

  if (!challenges.length && !brokers.length && !firms.length) {
    return errorResponse(baseHeaders, 502, 'All upstream data is empty');
  }

  // Кэшируем результат
  cache = {
    data: { challenges, brokers, firms },
    fetchedAt: Date.now()
  };

  return new Response(
    JSON.stringify({
      challenges,
      brokers,
      firms,
      fetchedAt: new Date().toISOString(),
      cached: false
    }),
    {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      }
    }
  );
}
