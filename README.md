# Market Proxy (Cloudflare Worker)

Прокси для Yahoo Finance, экономического календаря, OHLC и облачной синхронизации.

## Быстрый старт (для новых пользователей)

### Вариант 1: Через Wrangler (CLI)

1. Установите [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/):

   ```bash
   npm install -g wrangler
   ```

2. Авторизуйтесь:

   ```bash
   wrangler login
   ```

3. Создайте KV namespace:

   ```bash
   wrangler kv namespace create OHLC_KV
   ```

   Скопируйте `id` из вывода и вставьте в `wrangler.toml`:

   ```toml
   kv_namespaces = [
     { binding = "OHLC_KV", id = "ваш-id-здесь" }
   ]
   ```

4. Деплой:

   ```bash
   cd cloudflare-worker
   wrangler deploy
   ```

5. Скопируйте URL воркера (например `https://trader-journal.username.workers.dev`).

6. В журнале: **Настройки** → **Сервер** → **Worker URL** → вставьте URL → «Проверить».

### Вариант 2: Через Cloudflare Dashboard (без CLI)

1. Зайдите на [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Hello World** → задайте имя → **Deploy**.

2. Перейдите в созданный Worker → **Settings** → **Variables** → добавьте переменную окружения:
   - Имя: `CORS_ORIGIN`
   - Значение: `*` (или конкретный origin, см. ниже)

3. Перейдите в **Settings** → **Bindings** → **Add binding** → **KV Namespace**:
   - Имя переменной: `OHLC_KV`
   - Namespace: создайте новый или выберите существующий

4. Перейдите в **Edit Code** → удалите весь код → вставьте содержимое файла `serv-index.js` → нажмите **Deploy**.

5. Скопируйте URL воркера и вставьте в журнал: **Настройки** → **Сервер** → **Worker URL**.

## Эндпойнты

### Yahoo Finance

```
GET /yahoo/{symbol}?range=1d&interval=5m
```

Пример: `https://trader-journal.<account>.workers.dev/yahoo/SPY?range=1d&interval=5m`

Кэш: 5 минут.

### Экономический календарь

| Маршрут | Upstream | Примечание |
|---------|----------|------------|
| `GET /calendar/forexfactory?from=&to=` | `nfs.faireconomy.media/ff_calendar_thisweek.json` | Только текущая неделя; edge-кэш 60 мин |
| `GET /calendar/investing?from=&to=` | `ru.investing.com/.../getCalendarFilteredData` | POST + HTML; русская локаль |
| `GET /calendar/mql5?from=&to=` | `myfxbook.com/calendar_statement.xml` (fallback CSV) | Legacy — в UI заменён на TradingView |

Параметры: `from`, `to` — `YYYY-MM-DD`; `week=current` — текущая неделя.

### Cloud Sync

Синхронизация данных журнала между устройствами. Данные хранятся в KV 30 дней.

| Маршрут | Метод | Описание |
|---------|-------|----------|
| `/sync/push` | POST | Сохранить данные. Body: `{ code, data, timestamp }` |
| `/sync/pull?code=XXX` | GET | Получить данные по коду |
| `/sync/check` | POST | Проверить наличие. Body: `{ code }` |

Код синхронизации — 8 символов (a-z0-9), генерируется клиентом.

### OHLC (свечные данные)

| Маршрут | Метод | Описание |
|---------|-------|----------|
| `/ohlc/request` | POST | Запросить свечи. Body: `{ symbol, interval, period1, period2 }` |
| `/ohlc/poll` | GET | MQL5 Service опрашивает очередь |
| `/ohlc/result` | POST | MQL5 Service отдаёт бары |
| `/ohlc/result/:id` | GET | Получить результат по requestId |
| `/ohlc/health` | GET | Проверка здоровья |

## CORS

По умолчанию `Access-Control-Allow-Origin: *`. Чтобы ограничить origins, задайте переменную `CORS_ORIGIN`:

```
# Один origin
CORS_ORIGIN = "https://skifak.github.io/Trade-Journal-Site/"

# Несколько через запятую
CORS_ORIGIN = "https://skifak.github.io/Trade-Journal-Site/,http://localhost:5173"
```

## Безопасность

- Yahoo: только `/yahoo/{symbol}` с валидацией тикера; `range`/`interval` — из белого списка.
- Календарь: только `/calendar/forexfactory|investing|mql5|myfxbook`.
- Sync: код 4-16 символов, TTL 30 дней, max 5 MB.
- Запросы к upstream идут с браузерным User-Agent.
