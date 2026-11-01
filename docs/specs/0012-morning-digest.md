---
id: 0012-morning-digest
state: READY
attempt: 0
max_attempts: 3
branch: feat/0012-morning-digest
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: sweep-auth
    assert: "POST /sweep with a missing or wrong X-Sweep-Secret returns HTTP 401 and sends no digest"
  - id: cmd-on-default
    assert: "POST the command '/digest on' from user id U70; the reflected reply is exactly 'Ранковий звіт увімкнено. Надсилатиму щодня о 07:00.' and a '/export' from U70 shows digest.enabled == true and digest.atLocal == '07:00'"
  - id: cmd-set-time
    assert: "POST '/digest 08:30' from user id U71; the reflected reply is exactly 'Ранковий звіт щодня о 08:30.'; a '/export' from U71 shows digest.enabled == true and digest.atLocal == '08:30'; then POST '/digest' from U71 and the reflected reply is exactly 'Ранковий звіт: увімкнено, щодня о 08:30.'"
  - id: cmd-bad-time
    assert: "POST '/digest 25:99' from user id U72; the reflected reply is exactly 'Не зрозумів час. Приклад: /digest 07:30' and a '/export' from U72 shows digest == null"
  - id: cmd-off
    assert: "POST '/digest on' then '/digest off' from user id U73; the reflected reply to the second is exactly 'Ранковий звіт вимкнено.' and a '/export' from U73 shows digest.enabled == false"
  - id: export-has-digest-key
    assert: "A '/export' from a user id with nothing stored (U79) returns a reflected reply that parses as JSON whose 'digest' property is null"
  - id: digest-sent-early
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, POST '/digest 07:00' from user id U74 and POST 'Remind me today at 14:00 to take pills' from U74 (creates one scheduled reminder for 2026-09-16T14:00:00+03:00); read that reminder's stored title from '/export'. Then POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-09-16T06:45:00+03:00 (the 07:00 slot is inside the 30-minute look-ahead); the reflected replies contain exactly one string that starts with 'Доброго ранку' and contains the stored title and '14:00'; a '/export' from U74 shows digest.lastSentOn == '2026-09-16' and digest.nextDueAt == '2026-09-17T07:00:00+03:00'"
  - id: not-before-window
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, POST '/digest 07:00' from user id U75; POST /sweep with X-Test-Now=2026-09-16T06:20:00+03:00 (06:20 + 30 min = 06:50, the 07:00 slot is still outside the window); a '/export' from U75 shows digest.lastSentOn == null and digest.nextDueAt == '2026-09-16T07:00:00+03:00'"
  - id: idempotent-no-double-send
    assert: "After digest-sent-early, POST /sweep again with the same secret and X-Test-Now=2026-09-16T06:45:00+03:00; no reflected reply contains U74's stored reminder title, and U74's '/export' still shows digest.lastSentOn == '2026-09-16' and digest.nextDueAt == '2026-09-17T07:00:00+03:00' (the slot was advanced from the claimed slot, not from now, so the early tick did not re-arm today)"
  - id: only-today-listed
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, POST '/digest 07:00', 'Remind me today at 14:00 to call the bank' and 'Remind me tomorrow at 11:00 to renew the passport' from user id U76; read both stored titles from '/export' (told apart by eventAt). POST /sweep with X-Test-Now=2026-09-16T06:45:00+03:00; exactly one reflected reply starts with 'Доброго ранку', contains the 2026-09-16 reminder's stored title and does not contain the 2026-09-17 reminder's stored title"
  - id: delivery-and-digest-both-arrive
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, POST '/digest 07:00' and 'Remind me today at 07:10 to stretch' from user id U77; read the stored title from '/export'. POST /sweep with X-Test-Now=2026-09-16T06:45:00+03:00 (both the 07:10 reminder and the 07:00 digest are inside the look-ahead); the reflected replies contain exactly one string that starts with 'Нагадування:' and contains the stored title (the delivery) AND exactly one string that starts with 'Доброго ранку' and contains the stored title (the digest); a '/export' from U77 shows that reminder's notification status == 'sent' and digest.lastSentOn == '2026-09-16'"
  - id: stale-digest-skipped
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, POST '/digest 07:00' and 'Remind me today at 18:00 to buy milk' from user id U78. POST /sweep with X-Test-Now=2026-09-16T12:00:00+03:00 (five hours after the slot, past the 3-hour catch-up window); a '/export' from U78 shows digest.lastSentOn == null and digest.nextDueAt == '2026-09-17T07:00:00+03:00' (a morning report is not sent at noon)"
failures: []
---

# 0012 - Ранковий звіт (digest)

> **Критерії зафіксовано** (власник, `READY`). Рішення з розділу "Закриті питання" прийняті.

## Context

Зараз бот лише реагує: нагадування приходить тоді, коли настав його час, а повної картини дня немає.
Цей спек додає **один ранковий лист на день**: короткий звіт про те, що на сьогодні. У v1 там лише
розділ "Нагадування". Але звіт одразу будується як **збірка розділів**, щоб майбутній to-do, трекер
симптомів чи дані Garmin
([0010](0010-garmin-health-sync.md)) додавалися як ще один розділ без правок самого звіту.

Ідея вже є в [../architecture.md](../architecture.md), розділ 11 ("Morning digest"): "reuses the
sweeper, turns the bot from reactive into present". Цей спек її реалізує.

**Залежить від 0002-0005 і 0009, змерджених у `main`**: звіт читає документи нагадувань і їхні
сповіщення, і дописує до наявного `/sweep`.

## Рішення, прийняті в цьому спеку

1. **Без нового cron.** Звіт їде на тому самому тику Cloud Scheduler (`*/30`, `POST /sweep`), що й
   доставка нагадувань. Жодного нового секрету, Scheduler-джоба чи ендпоінта. Тик, що пропав,
   наздоганяється наступним (у межах вікна наздоганяння) (як і в [0003](0003-reminder-delivery.md)).
2. **Раніше, не пізніше - те саме правило, що й у нагадувань.** Тик бере звіт, чий слот потрапляє
   у вікно `now + REMINDER_SWEEP_INTERVAL_MINUTES` ([0003](0003-reminder-delivery.md)). Звіт на 07:00
   приходить на тику 06:30-06:59, до 30 хвилин раніше, і ніколи не пізніше за слот (крім наздоганяння
   після простою, див. нижче). Гранулярність 30 хвилин, і `/digest 07:10` прийде на тику, що
   передує 07:10 (README каже про це).
3. **"Коли наступний" живе в документі користувача.** `users/{id}.digest.nextDueAt` - UTC-момент
   наступного звіту. Тик питає Firestore лише про тих, у кого `nextDueAt <= cutoff`, тож вартість тика не
   росте з кількістю тих, кому звіт вже надіслано. Та сама ідея, що `status == 'scheduled'` для
   нагадувань.
4. **Claim, потім send** - як у нагадувань. У транзакції на документі користувача: якщо
   `nextDueAt <= cutoff`, пересунути `nextDueAt` на наступний слот **після заявленого слота** (не після
   `now`: тик іде раніше слота, і відлік від `now` перезапустив би сьогоднішній) і лише переможець транзакції збирає
   і шле звіт. Два накладні тики не можуть надіслати двічі.
5. **Звіт і нагадування - два окремі повідомлення, обидва приходять.** Нагадування, що стріляє на
   тому самому тику, звіт не заміщає і не прибирає зі списку: звіт - план дня, нагадування - сигнал.
   Тому звіт не залежить від порядку доставки і від статусу `sent`.
6. **Розділи - це плагіни.** Звіт знає лише інтерфейс `DigestSection`; кожен розділ реєструється у
   власному модулі. Розділ, що впав, не валить звіт (див. Contracts).
7. **Опт-ін, не за замовчуванням.** Звіт увімкнено командою `/digest on`. Бот не починає писати
   першим без прохання.

## Scope

- `src/digest/digest.types.ts` - **новий.** `DigestSection`, `DigestContext`, токен `DIGEST_SECTIONS`.
- `src/digest/digest.service.ts` - **новий.** Збірка звіту: опитати розділи, склеїти, не впасти.
- `src/digest/digest-schedule.ts` - **новий.** Чиста функція `nextDueAfter(now, atLocal, timezone)` та
  `isStale(now, dueAt, catchupHours)`. Без Nest, без годинника - приймає `now` аргументом.
- `src/digest/digest.module.ts` - **новий.**
- `src/digest/digest-settings.service.ts` - **новий.** Читання/запис `users/{id}.digest`, транзакція
  claim, `listDue(now)`.
- `src/reminders/reminders-digest.section.ts` - **новий.** Розділ "Нагадування" (єдиний у v1).
- `src/reminders/reminders.module.ts` - зареєструвати розділ у `DIGEST_SECTIONS`.
- `src/reminders/reminders.service.ts` - `listForDay(userId, dayStart, dayEnd)`: нагадування, чий
  `eventAt` потрапляє в локальну добу.
- `src/telegram/sweeper.service.ts` - після доставки нагадувань викликати `runDigests(now, sink)`.
- `src/telegram/telegram.service.ts` - команда `/digest`, рядок у `HELP_TEXT`, `digest` у `/export`,
  метод `sendDigest(chatId, text, sink)`.
- `src/reminders/humanize-time.ts` - лише якщо бракує допоміжної функції (дата у вигляді
  "16 вересня"); наявні функції не змінювати.
- `.env.example`, `cloudbuild.yaml` - `DIGEST_CATCHUP_HOURS` в `--set-env-vars` (за замовч. 3).
- `README.md` - один абзац: гранулярність 30 хвилин і що звіт їде на існуючому `/sweep`.
- `test/` - `digest-schedule.spec.ts`, `digest.service.spec.ts`,
  `reminders-digest.section.spec.ts`; оновити `sweeper.service.spec.ts`.
- `CLAUDE.md` - абзац в **Architecture**.

Поза межами без повернення в `DRAFT`: класифікатор, транскрипція, контракт вебхука, `docs/architecture.md`
(це ручний планувальний документ), будь-яка нова Firestore-композитна індексація.

## Contracts

### Дані: `users/{userId}.digest`

```ts
interface DigestSettings {
  enabled: boolean;
  /** Локальний час звіту, 'HH:mm', 24 год. */
  atLocal: string;
  /** IANA-зона. v1: завжди DEFAULT_TIMEZONE, але поле є, бо зона буде на користувача. */
  timezone: string;
  /** Куди слати. У приватному чаті дорівнює userId; береться з чату, де дали команду. */
  chatId: number;
  /** UTC-момент найближчого звіту. Тик бере тих, у кого він <= now. */
  nextDueAt: Timestamp;
  /** 'YYYY-MM-DD' (локальна доба) останнього *реально надісланого* звіту; null, якщо ще не було. */
  lastSentOn: string | null;
}
```

`/export` отримує ключ `digest`: `null`, якщо налаштувань немає, інакше об'єкт, де `atLocal`,
`enabled`, `lastSentOn` - як у документі, а `nextDueAt` показано локальним ISO з офсетом
(`2026-09-17T07:00:00+03:00`), так само як `eventAt`.

### Інтерфейс розділу (`src/digest/digest.types.ts`)

```ts
export interface DigestContext {
  userId: number;
  now: Date;
  timezone: string;
  /** Початок і кінець локальної доби, обчислені один раз і однаково для всіх розділів. */
  dayStart: Date;
  dayEnd: Date;
}

export interface DigestSection {
  /** Стабільний ідентифікатор для логів і майбутнього "вимкнути розділ X". */
  readonly id: string;
  /** Менше - вище в листі. Розділи сортуються за ним, не за порядком реєстрації. */
  readonly order: number;
  /**
   * Рядки розділу без заголовка або null, якщо сьогодні нічого. null/[] означає "розділ не
   * показується", а не "порожній заголовок".
   */
  build(ctx: DigestContext): Promise<DigestSectionResult | null>;
}

export interface DigestSectionResult {
  title: string;       // 'Нагадування'
  lines: string[];     // кожен без маркера: сервіс додає '• '
}

export const DIGEST_SECTIONS = Symbol('DIGEST_SECTIONS');  // multi-provider токен Nest
```

Додати розділ у майбутньому = один клас, що реалізує `DigestSection`, і один рядок
`{ provide: DIGEST_SECTIONS, useClass: ..., multi... }` у його власному модулі. `DigestService`,
`SweeperService` і `/digest` не змінюються. (Nest не має справжнього multi-provider; реалізація
використовує масив-провайдер із `useFactory` і `inject: [...]` або реєстр, куди розділи
реєструються в `onModuleInit`. Вибір - за імплементатором, але зовнішня форма така, як вище.)

### `DigestService.build(ctx)`

1. Опитати всі розділи **паралельно**, кожен у власному `try/catch`.
2. Розділ, що кинув помилку: залогувати `id` розділу і userId (не вміст), пропустити його.
   Решта розділів і далі йдуть у лист.
3. Відкинути `null` і порожні `lines`. Якщо не лишилось нічого - повернути `undefined`.
4. Відсортувати за `order`, скласти:

```
Доброго ранку! Сьогодні 16 вересня.

Нагадування
• Прийняти таблетки - о 14:00
• Лікар - о 17:30
```

Без `parse_mode`. Дата - через наявні допоміжні функції (`MONTHS_GENITIVE`), сирий ISO у чат не
потрапляє ([../../CLAUDE.md](../../CLAUDE.md), "No raw timestamp ever reaches the chat"). Час у рядку -
`humanizeTimeOfDay`.

**Ліміт на розділ:** не більше `DIGEST_MAX_LINES_PER_SECTION = 15` рядків, далі
`• …і ще N` (`N` - точно скільки відкинуто). Інакше один розділ-велетень (колись to-do на 80 пунктів)
витіснить усе інше, а 4096-символьне чанкування Telegram розріже лист посеред розділу.

### Розділ "Нагадування" (`reminders-digest.section.ts`, `order: 100`)

Показує нагадування, чий **`eventAt` потрапляє в сьогоднішню локальну добу** і які ще актуальні:
статус `scheduled` або `sent`; **не** `acked` (зроблено) і не `cancelled`. Нагадування, що вже
доставлене сьогодні, але ще не відмічене "Готово", у звіті є: звіт - це план дня, а не черга
недоставленого. Один рядок на нагадування, не на сповіщення: прийом лікаря о 14:00 з двома
сповіщеннями ("ввечері перед" і "вранці в день") - це один рядок. Час у рядку - це `eventAt` (коли
*подія*), а не `at` сповіщення. Сортування за часом зростанням.

Читання: один запит до `users/{id}/reminders` за `eventAtUtc >= dayStart && < dayEnd`
(одне поле, автоіндекс; **без** нового композитного індексу), статус фільтрується в пам'яті.
Повторювані нагадування працюють без змін: їхній `eventAt` завжди вказує на озброєну оказію.

Дублювання між доставкою і звітом - **бажане**: користувач отримує і звіт зранку, і саме нагадування
у свій час.

### Порядок у `SweeperService.sweep`

1. Доставка нагадувань (як зараз).
2. `runDigests(now, sink)`.

Порядок не впливає на вміст звіту (звіт не залежить від статусу `sent`), але кроки **незалежні**: збій
одного (кожен у власному `try/catch`) не блокує другий, і `/sweep` завжди відповідає `200`.

### `runDigests(now, sink)`

1. `cutoff = now + REMINDER_SWEEP_INTERVAL_MINUTES` (той самий look-ahead, що й у нагадувань).
   `listDue(cutoff)`: користувачі з `digest.enabled == true && digest.nextDueAt <= cutoff`.
2. Для кожного, послідовно, у власному `try/catch`:
   1. **Бар'єр доступу:** `userId` має бути в `ALLOWED_USERS` (та сама перевірка, що й для апдейтів).
      Ні - пересунути `nextDueAt`, нічого не слати, залогувати. Бот ніколи не пише першим тому, кого
      вже вилучено зі списку, навіть якщо документ лишився в Firestore.
   2. **Claim:** транзакція - перечитати `nextDueAt`; якщо ще `<= cutoff`, записати
      `nextDueAt = nextDueAfter(старий nextDueAt, atLocal, timezone)` - найближчий слот строго
      **після заявленого**, не після `now`. Не переможець - `continue`.
   3. **Застарілість:** якщо `now > заявлений слот + DIGEST_CATCHUP_HOURS` (після простою), звіт
      **пропускається** (слот уже пересунуто). Ранковий звіт о 15:00 - абсурд. Ранні тики
      (`now` до слота) застарілими не бувають.
   4. Побудувати звіт. `undefined` (усі розділи порожні) - нічого не слати.
   5. Надіслати; після успіху записати `lastSentOn = <локальна дата>`.
3. Невдала відправка (бот заблокований, 403, мережа): залогувати id і код, **не повторювати**
   (як у 0003). Слот уже пересунуто, завтра буде наступний.

`nextDueAfter(after, atLocal, tz)` повертає **найближчий слот строго після `after`** у локальному часі
зони, тож DST-зміна не зсуває "07:00" (береться зі стіни, не з додавання 24 годин).

### Команда `/digest`

Маршрутизується до класифікації, як усі `/`-команди. Відповіді - точні рядки (детермінована
поверхня, не модель):

| Ввід | Відповідь |
|---|---|
| `/digest on` | `Ранковий звіт увімкнено. Надсилатиму щодня о 07:00.` (07:00 - якщо час ще не заданий; інакше збережений) |
| `/digest HH:mm` (напр. `/digest 08:30`) | `Ранковий звіт щодня о 08:30.` (і вмикає звіт) |
| `/digest off` | `Ранковий звіт вимкнено.` (час зберігається) |
| `/digest` | `Ранковий звіт: увімкнено, щодня о 08:30.` або `Ранковий звіт: вимкнено.` |
| `/digest <нерозбірливе>` | `Не зрозумів час. Приклад: /digest 07:30` (нічого не змінюється) |

`HH:mm` приймає `7:30` і `07:30`; відхиляє `25:99`. Увімкнення рахує `nextDueAt` = найближчий слот
**строго після** моменту команди: `/digest 07:00`, надане о 07:10, перший звіт дає завтра, а не
негайно (тихе "а чому прийшов сам, без запиту" гірше за добу очікування). Надане о 06:50 - перший
звіт сьогодні о 07:00 (на тику, що його покриває).

Команда проходить `ALLOWED_USERS` так само, як і решта, і пише `chatId` чату, де її дали.

## Invariants (must not break)

- Вебхук і `/sweep` відповідають `200` у всіх випадках, крім хибного секрету (`401`). Збій розділу,
  Firestore чи Telegram - у лог, не `5xx`: Cloud Scheduler повторює `5xx`, а це видало б дубль-звіт.
- Бар'єр `ALLOWED_USERS` стоїть **перед** будь-якою відправкою звіту, а не лише перед апдейтами.
- Подвійна відправка неможлива: `nextDueAt` пересувається в транзакції до відправки.
- Відповіді й звіт без `parse_mode`: заголовки нагадувань - слова користувача, Markdown зламався б на
  підкресленні.
- Жоден сирий ISO-час не потрапляє в чат. Час - лише через `humanize-time.ts`.
- Health-data дисципліна: ніколи не логувати `title`, текст звіту чи вміст розділів. Лише `userId`,
  `id` розділу, кількість рядків, коди помилок.
- Розділ, що впав, ніколи не блокує інші розділи й не 500-ить `/sweep`.
- Жодного нового секрету, ендпоінта чи Scheduler-джоба; жодного `gcloud`. Усе GCP-налаштування (якщо
  буде) - Console-інструкціями в README.

## Підводні камені (враховані вище, і ті, що ні)

**Враховані в Contracts:**

- **Звіт і нагадування - окремі повідомлення.** Нагадування на 07:15 стріляє на тику 07:00 і лежить
  у звіті того ж тику: обидва приходять, це вимога, не баг. Звіт тому не фільтрує за `sent`.
- **Слот рахується від заявленого слота, не від `now`.** Звіт іде раніше слота; відлік "завтра" від
  `now` дав би сьогоднішній слот знову, і звіт прийшов би двічі (та сама пастка, що з
  `enqueueNextOccurrence` у повторюваних нагадувань).
- **Доба і DST.** Доба = `[00:00, 00:00)` локального часу зони; у дні переходу вона 23 або 25 годин.
  Межі беруться через `startOf('day')` і `plus({days: 1})` luxon, не додаванням `24h`.
- **Простій.** Без вікна наздоганяння після простою о 15:00 прийшов би "ранковий" звіт.
  `DIGEST_CATCHUP_HOURS`.
- **Лист, що не влазить.** Ліміт на розділ + чанкування `sendMessage`.
- **Порожній день.** Див. відкрите питання 2.
- **Користувач заблокував бота / вилучений із `ALLOWED_USERS`.** Не 5xx, без повторів, без листа.
- **Збій одного розділу.** Ізольований; решта йде.
- **Вартість тика.** Один запит до `users` за `digest.nextDueAt <= now`; після того як звіт
  надіслано, користувач у вибірку не потрапляє до завтра.

**Свідомо не вирішені (див. Out of scope):**

- Сповіщення, яке спрацює **сьогодні**, але для події **іншого дня** ("нагадаю о 19:00 про завтрашній
  візит"), у звіт v1 **не** входить: розділ дивиться на `eventAt`, не на `at`.
- Часова зона на користувача: v1 бере `DEFAULT_TIMEZONE`.
- Гранулярність 30 хвилин: точніший час потребує частішого cron.

## Acceptance criteria (locked at READY)

Дзеркало frontmatter. Верифікатор шле запити на тестову функцію з `X-Test-Now`, автентифікує `/sweep`
через `TEST_SWEEP_SECRET` і стверджує про **збережену структуру** (`/export`) та точні детерміновані
рядки команд, не про формулювання моделі. Кожен критерій має свій `from.id` (U70-U79), щоб стан не
перетікав між перевірками. Заголовок нагадування читається з `/export`, а не вгадується, бо його
виводить модель.

- **health / sweep-auth** - функція жива, ендпоінт закритий без секрету.
- **cmd-on-default / cmd-set-time / cmd-bad-time / cmd-off** - точні відповіді команди і збережений
  стан.
- **export-has-digest-key** - `/export` має ключ `digest` (`null`, коли нічого немає).
- **digest-sent-early** - звіт приходить на тику, що передує слоту (look-ahead); містить заголовок і
  час нагадування; `lastSentOn` і `nextDueAt` оновлено.
- **not-before-window** - тик, чиє вікно слота ще не охоплює, звіту не шле.
- **idempotent-no-double-send** - повторний `/sweep` не шле вдруге, а слот пересунуто від заявленого.
- **only-today-listed** - завтрашнє нагадування в сьогоднішній звіт не потрапляє.
- **delivery-and-digest-both-arrive** - на одному тику приходять і нагадування, і звіт, і нагадування
  є в обох.
- **stale-digest-skipped** - після простою понад вікно наздоганяння звіт пропущено.

Юніт-тести, які імплементатор мусить додати (детерміновані, без мережі): `nextDueAfter` (звичайний день,
перетин півночі, DST весна/осінь для `Europe/Kyiv`, `after` = рівно слот, ранній тик перед слотом не
дає сьогоднішній слот знову); look-ahead відбір (`slot <= now + interval`); `isStale`; `DigestService`
(порядок за `order`, розділ, що кидає виняток, не блокує решту, усі порожні дають `undefined`, ліміт
15 рядків і точне "і ще N"); розділ нагадувань (лише сьогоднішня доба, `sent` лишається в списку, не `acked`, один рядок на
нагадування з кількома сповіщеннями, сортування); відмова `ALLOWED_USERS` у `runDigests` (слот
пересунуто, нічого не надіслано); розбір `/digest` (`7:30`, `07:30`, `25:99`, `on`, `off`, порожньо).

## Закриті питання (рішення власника)

1. **Порожній день:** звіт мовчить, нічого не надсилає. Критерії написано під це.
2. **Мова:** відповіді `/digest` і рядок у `HELP_TEXT` - українською.
3. **Сповіщення сьогодні про подію іншого дня:** у звіт v1 не входить (окремий спек, коли знадобиться).
4. **Розділ вимикається окремо?** **Вирішено (власник):** ні. У v1 вимикається лише весь звіт;
   усі зареєстровані розділи завжди ввімкнені, а `/digest` керує лише часом і вкл/викл. Інтерфейс
   (`id` розділу) уже дозволяє `/digest sections` пізніше без перебудови.

## Out of scope

- **Розділ to-do.** Цей спек лише гарантує, що він додається без правок звіту. Сам to-do - окремий
  спек.
- **Розділи для симптомів, Garmin, нотаток.** Те саме правило: окремі спеки, окремі `DigestSection`.
- **Часова зона на користувача** і `/timezone`.
- **Звіт на запит** (`/today`): та сама `DigestService.build`, інша точка входу. Свідомо не тут, але
  розділена збірка робить його дрібним доповненням.
- **Вечірній підсумок**, тижневий огляд: той самий механізм (`nextDueAt` + розділи), інші слоти.
- **Кнопки під звітом** (Готово/Відкласти на пункт). Звіт v1 - лише текст.
- **Природномовне керування** ("надсилай звіт о 8"). Лише `/digest`.
- **Точніше за 30 хвилин** і повтор невдалої відправки.
