---
id: 0012-morning-digest
state: IN-TESTING
attempt: 0
max_attempts: 3
branch: feat/0012-morning-digest
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: digest-auth
    assert: "POST /ingest/digest without X-Ingest-Secret or with a wrong one returns 401 with no replies; with a valid secret and no userId returns 400 with error == \"invalid_user\"; with a valid secret and userId 900000007 (not in the test allowlist) returns 403 with error == \"user_not_allowed\" and no replies"
  - id: cmd-on-off-status
    assert: "From U1: POST '/digest' and the reflected reply is exactly 'Ранковий звіт: вимкнено.'; POST '/digest on' and the reply is exactly 'Ранковий звіт увімкнено.' and a '/export' shows digest.enabled == true; POST '/digest' and the reply is exactly 'Ранковий звіт: увімкнено.'; POST '/digest off' and the reply is exactly 'Ранковий звіт вимкнено.' and a '/export' shows digest.enabled == false"
  - id: cmd-bad-arg-and-export-key
    assert: "From U2: a '/export' first returns JSON whose 'digest' property is null; POST '/digest 08:30' and the reflected reply is exactly 'Не зрозумів. Команди: /digest on, /digest off'; a '/export' still shows digest == null"
  - id: disabled-sends-nothing
    assert: "From U5 (digest never enabled): POST /ingest/digest (valid secret, userId 900000005) returns 200 with sent == false, reason == \"disabled\" and no reply starting with 'Доброго ранку'"
  - id: empty-day-silent
    assert: "Continuing U5: POST '/digest on' with no reminders for the day, then POST /ingest/digest with X-Test-Now=2026-09-16T07:00:00+03:00 returns sent == false, reason == \"empty\", and a '/export' from U5 shows digest.lastSentOn == null"
  - id: digest-sent-with-reminder
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, from U3 POST '/digest on' and 'Remind me today at 14:00 to take pills'; read the stored title from '/export'. POST /ingest/digest (userId 900000003) with X-Test-Now=2026-09-16T07:00:00+03:00 returns sent == true and replies contains exactly one string that starts with 'Доброго ранку' and contains the stored title and '14:00'; a '/export' from U3 shows digest.lastSentOn == '2026-09-16'"
  - id: idempotent-no-double-send
    assert: "After digest-sent-with-reminder, POST /ingest/digest for U3 again with the same X-Test-Now: sent == false, reason == \"already_sent\", no reply contains the stored title, and '/export' still shows digest.lastSentOn == '2026-09-16'; then with X-Test-Now=2026-09-17T07:00:00+03:00 after creating 'Remind me tomorrow at 14:00 to stretch' (with X-Test-Now=2026-09-16T06:00:00+03:00), the call returns sent == true"
  - id: only-today-listed
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, from U4 POST '/digest on', 'Remind me today at 14:00 to call the bank' and 'Remind me tomorrow at 11:00 to renew the passport'; read both stored titles from '/export' (told apart by eventAt). POST /ingest/digest (userId 900000004) with X-Test-Now=2026-09-16T07:00:00+03:00: exactly one reply starts with 'Доброго ранку', contains the 2026-09-16 reminder's stored title and does not contain the 2026-09-17 reminder's stored title"
  - id: delivery-and-digest-both-arrive
    assert: "With X-Test-Now=2026-09-16T06:00:00+03:00, from U6 POST '/digest on' and 'Remind me today at 07:10 to stretch'; read the stored title from '/export'. POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-09-16T06:45:00+03:00: replies contain exactly one string that starts with 'Нагадування:' and contains the stored title and no string that starts with 'Доброго ранку'. Then POST /ingest/digest (userId 900000006) with X-Test-Now=2026-09-16T07:00:00+03:00: exactly one reply starts with 'Доброго ранку' and contains the stored title; a '/export' from U6 shows that reminder's notification status == 'sent' and digest.lastSentOn == '2026-09-16'"
failures: []
---

# 0012 - Ранковий звіт (digest)

> **Критерії зафіксовано** (власник, `READY`, 2026-11-02). Переписано з варіанта зі `/sweep`: звіт запускає
> ранкова джоба ([0022](0022-morning-run.md)) викликом `POST /ingest/digest`. Рішення з розділу "Закриті
> питання" прийняті.

## Context

Зараз бот лише реагує: нагадування приходить тоді, коли настав його час, а повної картини дня немає.
Цей спек додає **один ранковий лист на день**: короткий звіт про те, що на сьогодні. У v1 там лише
розділ "Нагадування". Але звіт одразу будується як **збірка розділів**, щоб Garmin
([0018](0018-digest-garmin-sections.md)), календар ([0014](0014-calendar-sync.md)), to-do чи трекер
симптомів додавалися як ще один розділ без правок самого звіту.

**Хто запускає.** Не бот за власним годинником, а виклик `POST /ingest/digest`, який робить ранкова
джоба ([0022](0022-morning-run.md)) після того, як витягла дані Garmin (з ретраями) або вичерпала
спроби. Час звіту задає Cloud Scheduler у Console, а не чат.

Ідея вже є в [../architecture.md](../architecture.md), розділ 11 ("Morning digest"): "turns the bot from
reactive into present". Цей спек її реалізує.

**Залежить від 0002-0005, змерджених у `main`**: звіт читає документи нагадувань. (0009 не потрібен: розділ читає лише `eventAt` і статус, а не вид нагадування.) Ендпоінт
користується `IngestGuard` з [0013](0013-iphone-quick-capture.md) і `userId` у тілі з
[0017](0017-ingest-user-id.md).

## Рішення, прийняті в цьому спеку

1. **Без нового cron у боті.** Бот сам звіт не планує. `/sweep` цим спеком **не змінюється** (жодних
   кроків звіту в ньому). Звіт їде, коли хтось з секретом викличе `POST /ingest/digest`.
2. **Раз на добу, захист від дубля.** `users/{id}.digest.lastSentOn` - локальна дата останнього звіту.
   Другий виклик того ж дня відповідає `sent:false, reason:"already_sent"` і нічого не шле. Запис
   робиться транзакцією (claim) **до** відправки: два накладні виклики не можуть надіслати двічі.
3. **Звіт і нагадування - два окремі повідомлення, обидва приходять.** Нагадування, що стріляє на тому
   ж тику `/sweep`, звіт не заміщає: звіт - план дня, нагадування - сигнал. Звіт не залежить від
   статусу `sent`.
4. **Розділи - це плагіни.** Звіт знає лише інтерфейс `DigestSection`; кожен розділ реєструється у
   власному модулі. Розділ, що впав, не валить звіт (див. Contracts).
5. **Опт-ін, не за замовчуванням.** Звіт увімкнено командою `/digest on`. Бот не пише першим без
   прохання, навіть коли джоба його викликає.
6. **Час звіту не живе в боті.** Команди `/digest 08:30` немає. Час - це розклад Cloud Scheduler
   ([0022](0022-morning-run.md)). Команда лише вмикає й вимикає.
7. **Порожній день - мовчання.** Усі розділи порожні: нічого не слати, не займати добу.

## Scope

- `src/digest/digest.types.ts` - **новий.** `DigestSection`, `DigestContext`, токен `DIGEST_SECTIONS`.
- `src/digest/digest.service.ts` - **новий.** Збірка звіту: опитати розділи, склеїти, не впасти.
- `src/digest/local-day.ts` - **новий.** Чиста функція `localDay(now, timezone)` ->
  `{ dateKey: 'YYYY-MM-DD', dayStart, dayEnd }`. Без Nest, без годинника - приймає `now` аргументом.
- `src/digest/digest-settings.service.ts` - **новий.** Читання/запис `users/{id}.digest`, транзакція
  claim `claimToday(userId, dateKey)`.
- `src/digest/digest-runner.service.ts` - **новий.** `run(userId, now, sink)`: вся логіка
  `/ingest/digest` (див. Contracts).
- `src/digest/digest.module.ts` - **новий.**
- `src/reminders/reminders-digest.section.ts` - **новий.** Розділ "Нагадування" (єдиний у v1).
- `src/reminders/reminders.module.ts` - зареєструвати розділ у `DIGEST_SECTIONS`.
- `src/reminders/reminders.service.ts` - `listForDay(userId, dayStart, dayEnd)`: нагадування, чий
  `eventAt` потрапляє в локальну добу.
- `src/ingest/ingest.controller.ts` - `POST /ingest/digest`.
- `src/telegram/telegram.service.ts` - команда `/digest` (`on`/`off`/статус), рядок у `HELP_TEXT`,
  `digest` у `/export`, метод `sendDigest(chatId, text, sink)`.
- `src/reminders/humanize-time.ts` - лише якщо бракує допоміжної функції (дата у вигляді
  "16 вересня"); наявні функції не змінювати.
- `README.md` - один абзац: звіт їде з ранкової джоби, час - у Scheduler.
- `test/` - `local-day.spec.ts`, `digest.service.spec.ts`, `reminders-digest.section.spec.ts`,
  `digest-runner.service.spec.ts`.
- `CLAUDE.md` - абзац в **Architecture**.

Поза межами без повернення в `DRAFT`: `/sweep` і `SweeperService`, класифікатор, транскрипція, контракт
вебхука, `docs/architecture.md` (ручний планувальний документ), будь-яка нова Firestore-композитна
індексація, ранкова джоба (це [0022](0022-morning-run.md)).

## Contracts

### Дані: `users/{userId}.digest`

```ts
interface DigestSettings {
  enabled: boolean;
  /** Куди слати. У приватному чаті дорівнює userId; береться з чату, де дали команду. */
  chatId: number;
  /** 'YYYY-MM-DD' (локальна доба) останнього звіту, для якого зроблено claim; null, якщо ще не було. */
  lastSentOn: string | null;
}
```

Зона - `DEFAULT_TIMEZONE` (на користувача зони поки немає, див. Out of scope).

`/export` отримує ключ `digest`: `null`, якщо налаштувань немає, інакше `{enabled, lastSentOn}`.

### `POST /ingest/digest`

Заголовки й перевірки як в `/ingest/message` ([0013](0013-iphone-quick-capture.md),
[0017](0017-ingest-user-id.md)), у фіксованому порядку:

1. `X-Ingest-Secret` невірний або ingest не налаштовано - `401`.
2. Тіло `{ "userId": 900000001 }`. `userId` відсутній чи не додатне ціле (число або рядок цифр) - `400
   {"ok":false,"error":"invalid_user"}`.
3. `userId` не в `ALLOWED_USERS` - `403 {"ok":false,"error":"user_not_allowed"}`. Нічого не шлеться і не
   читається далі.
4. Далі завжди `200` (збій після валідації - у лог). Тіло: `{ "ok": true, "sent": boolean,
   "reason"?: string, "replies"?: string[] }`. `replies` - лише на тестовій функції
   (`TEST_REFLECT_REPLY=true`), яка ще й шанує `X-Test-Now`; та сама довірча межа, що й у `/ingest/message`.

Логіка `DigestRunnerService.run(userId, now, sink)`:

1. `digest` відсутній або `enabled != true` - `sent:false, reason:"disabled"`.
2. `localDay(now, tz)`. `lastSentOn == dateKey` - `sent:false, reason:"already_sent"`.
3. Побудувати звіт (`DigestService.build`). `undefined` (усе порожньо) - `sent:false, reason:"empty"`;
   claim **не** робиться (порожній день не займає добу).
4. **Claim:** транзакція - перечитати; якщо `lastSentOn == dateKey`, програли - `already_sent`; інакше
   записати `lastSentOn = dateKey`.
5. Надіслати. Збій (бот заблокований, 403, мережа): залогувати id і код, **не повторювати**, відповісти
   `sent:false, reason:"send_failed"`. Claim уже зроблено, тож повтор того ж дня нічого не надішле
   (так само, як у [0003](0003-reminder-delivery.md): не повторювати).
6. Успіх - `sent:true`.

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

Додати розділ у майбутньому = один клас, що реалізує `DigestSection`, і один рядок реєстрації у його
власному модулі. `DigestService`, `DigestRunnerService` і `/digest` не змінюються. (Nest не має
справжнього multi-provider; реалізація використовує масив-провайдер із `useFactory` і `inject: [...]`
або реєстр, куди розділи реєструються в `onModuleInit`. Вибір - за імплементатором, зовнішня форма
така, як вище.)

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
*подія*), а не `at` сповіщення. Сортування за часом зростанням. Подія на весь день (день народження
без часу) показується без "о HH:mm".

Читання: один запит до `users/{id}/reminders` за `eventAtUtc >= dayStart && < dayEnd`
(одне поле, автоіндекс; **без** нового композитного індексу), статус фільтрується в пам'яті.
Повторювані нагадування працюють без змін: їхній `eventAt` завжди вказує на озброєну оказію.

Дублювання між звітом і самим нагадуванням - **бажане**: користувач отримує і звіт зранку, і саме
нагадування у свій час.

### Команда `/digest`

Маршрутизується до класифікації, як усі `/`-команди. Відповіді - точні рядки (детермінована
поверхня, не модель):

| Ввід | Відповідь |
|---|---|
| `/digest on` | `Ранковий звіт увімкнено.` (пише `enabled=true`, `chatId` чату, де дали команду; `lastSentOn` не чіпає) |
| `/digest off` | `Ранковий звіт вимкнено.` |
| `/digest` | `Ранковий звіт: увімкнено.` або `Ранковий звіт: вимкнено.` (немає налаштувань - `вимкнено`) |
| `/digest <щось інше>` | `Не зрозумів. Команди: /digest on, /digest off` (нічого не змінюється) |

Команда проходить `ALLOWED_USERS` так само, як і решта.

## Invariants (must not break)

- Вебхук, `/sweep` і `/ingest/digest` після валідації відповідають `200`; збій розділу, Firestore чи
  Telegram - у лог. Виняток `/ingest/digest`: `401`, `400`, `403` як у розділі вище.
- Бар'єр `ALLOWED_USERS` стоїть **перед** будь-яким читанням чи відправкою звіту.
- Подвійна відправка неможлива: claim `lastSentOn` у транзакції до відправки.
- Відповіді й звіт без `parse_mode`: заголовки нагадувань - слова користувача, Markdown зламався б на
  підкресленні.
- Жоден сирий ISO-час не потрапляє в чат. Час - лише через `humanize-time.ts`.
- Health-data дисципліна: ніколи не логувати `title`, текст звіту чи вміст розділів. Лише `userId`,
  `id` розділу, кількість рядків, коди помилок.
- Розділ, що впав, ніколи не блокує інші розділи й не 500-ить ендпоінт.
- `/sweep` і `SweeperService` цим спеком не змінюються.
- Жодного нового секрету, Scheduler-джоба чи `gcloud`: `INGEST_SECRET` уже існує. Усе GCP-налаштування
  (якщо буде) - Console-інструкціями в README.

## Підводні камені

- **Звіт і нагадування - окремі повідомлення.** Нагадування на 07:15 стріляє на тику `/sweep` і лежить
  у звіті: обидва приходять, це вимога, не баг. Звіт тому не фільтрує за `sent`.
- **Доба і DST.** Доба = `[00:00, 00:00)` локального часу зони; у дні переходу вона 23 або 25 годин.
  Межі беруться через `startOf('day')` і `plus({days: 1})` luxon, не додаванням `24h`.
- **Лист, що не влазить.** Ліміт на розділ + чанкування `sendMessage`.
- **Порожній день.** Мовчання, claim не робиться.
- **Користувач заблокував бота / вилучений із `ALLOWED_USERS`.** `403`/без відправки, без повторів.
- **Збій одного розділу.** Ізольований; решта йде.
- **Джоба не викликала ендпоінт.** Звіту того дня немає; ніхто його не наздоганяє (свідомо: ранковий
  звіт у обід безглуздий). Це відповідальність [0022](0022-morning-run.md), яка викликає ендпоінт у
  `finally`.

**Свідомо не вирішені:**

- Сповіщення, яке спрацює **сьогодні**, але для події **іншого дня** ("нагадаю о 19:00 про завтрашній
  візит"), у звіт **не** входить: розділ дивиться на `eventAt`, не на `at`.
- Часова зона на користувача: v1 бере `DEFAULT_TIMEZONE`.

## Acceptance criteria (locked at READY)

Дзеркало frontmatter. Верифікатор шле запити на тестову функцію з
`X-Test-Now`, автентифікує `/ingest/digest` через `X-Ingest-Secret`, `/sweep` через `TEST_SWEEP_SECRET`,
і стверджує про **збережену структуру** (`/export`), `replies` та точні детерміновані рядки команд, не
про формулювання моделі. Користувачі - шість тестових id з [0016](0016-split-allowed-users.md)
(U1-U6 = `900000001`-`900000006`), станом не діляться між перевірками. Заголовок нагадування
читається з `/export`, а не вгадується, бо його виводить модель.

- **health** - `GET /` дає `200 {"status":"ok"}`.
- **digest-auth** - `POST /ingest/digest` без секрету чи з хибним - `401`, без `replies`; без `userId` -
  `400 invalid_user`; `userId` `900000007` (поза тестовим списком) - `403 user_not_allowed`, без `replies`.
- **cmd-on-off-status** (U1) - `/digest` дає `Ранковий звіт: вимкнено.`; `/digest on` дає `Ранковий звіт
  увімкнено.` і `/export` показує `digest.enabled == true`; `/digest` дає `Ранковий звіт: увімкнено.`;
  `/digest off` дає `Ранковий звіт вимкнено.` і `/export` показує `digest.enabled == false`.
- **cmd-bad-arg-and-export-key** (U2) - `/export` ще до всього має `digest` рівне `null`; `/digest 08:30`
  дає `Не зрозумів. Команди: /digest on, /digest off`; `/export` і далі `digest == null`.
- **disabled-sends-nothing** (U5, звіт не вмикали) - `POST /ingest/digest` дає `200`, `sent == false`,
  `reason == "disabled"`, без звіту в `replies`.
- **empty-day-silent** (U5 далі) - `/digest on`, нагадувань на сьогодні немає, `POST /ingest/digest` дає
  `sent == false`, `reason == "empty"`, а `/export` показує `digest.lastSentOn == null`.
- **digest-sent-with-reminder** (U3) - з `X-Test-Now=2026-09-16T06:00:00+03:00`: `/digest on` і `Remind me
  today at 14:00 to take pills`, заголовок із `/export`; `POST /ingest/digest` з
  `X-Test-Now=2026-09-16T07:00:00+03:00` дає `sent == true`, `replies` містить рівно один рядок, що
  починається з `Доброго ранку` і містить збережений заголовок та `14:00`; `/export` показує
  `digest.lastSentOn == "2026-09-16"`.
- **idempotent-no-double-send** (U3 далі) - повторний `POST /ingest/digest` з тим самим `X-Test-Now`
  дає `sent == false`, `reason == "already_sent"`, `replies` без заголовка нагадування, `lastSentOn` той
  самий; з `X-Test-Now=2026-09-17T07:00:00+03:00` і новим нагадуванням на 17-те дає `sent == true`.
- **only-today-listed** (U4) - із `X-Test-Now=2026-09-16T06:00:00+03:00`: `/digest on`, `Remind me today at
  14:00 to call the bank` і `Remind me tomorrow at 11:00 to renew the passport`, обидва заголовки з
  `/export` (розрізняються за `eventAt`); `POST /ingest/digest` з `X-Test-Now=2026-09-16T07:00:00+03:00`:
  рівно один рядок `Доброго ранку`, містить заголовок 16-го і не містить заголовка 17-го.
- **delivery-and-digest-both-arrive** (U6) - із `X-Test-Now=2026-09-16T06:00:00+03:00`: `/digest on` і
  `Remind me today at 07:10 to stretch`, заголовок із `/export`. `POST /sweep` з
  `X-Test-Now=2026-09-16T06:45:00+03:00`: `replies` містить рівно один рядок `Нагадування:` із заголовком
  **і жодного** `Доброго ранку` (sweep звіту не шле). Потім `POST /ingest/digest` з
  `X-Test-Now=2026-09-16T07:00:00+03:00`: один рядок `Доброго ранку` теж із заголовком; `/export`
  показує сповіщення нагадування `status == "sent"` і `digest.lastSentOn == "2026-09-16"`.

Юніт-тести, які імплементатор мусить додати (детерміновані, без мережі): `localDay` (звичайний день,
DST весна/осінь для `Europe/Kyiv`, доба 23 і 25 годин, `now` рівно опівночі); `DigestService` (порядок за
`order`, розділ, що кидає виняток, не блокує решту, усі порожні дають `undefined`, ліміт 15 рядків і
точне "і ще N"); розділ нагадувань (лише сьогоднішня доба, `sent` лишається в списку, не `acked`, один
рядок на нагадування з кількома сповіщеннями, сортування, подія на весь день); `DigestRunnerService`
(`disabled`, `already_sent`, `empty` без claim, програш claim у гонці, `send_failed` без повтору);
порядок перевірок контролера (`401`, `400`, `403`); розбір `/digest` (`on`, `off`, порожньо, `08:30`,
сміття).

## Закриті питання (рішення власника)

1. **Порожній день:** звіт мовчить, нічого не надсилає.
2. **Мова:** відповіді `/digest` і рядок у `HELP_TEXT` - українською.
3. **Сповіщення сьогодні про подію іншого дня:** у звіт v1 не входить.
4. **Розділ вимикається окремо?** Ні. У v1 вимикається лише весь звіт; `/digest` керує лише вкл/викл.
   Інтерфейс (`id` розділу) уже дозволяє `/digest sections` пізніше без перебудови.
5. **Хто і коли запускає звіт (2026-11-02):** ранкова джоба о 07:00 після синку Garmin
   ([0022](0022-morning-run.md)), не 30-хвилинний `/sweep`. Час звіту змінюється в Cloud Scheduler.

## Out of scope

- **Розділ to-do.** Цей спек лише гарантує, що він додається без правок звіту.
- **Розділи для симптомів, Garmin, нотаток.** Окремі спеки, окремі `DigestSection`
  ([0018](0018-digest-garmin-sections.md) для Garmin).
- **Часова зона на користувача** і `/timezone`.
- **Час звіту командою** (`/digest 08:30`) і будь-яке планування звіту всередині бота.
- **Звіт на запит** (`/today`): та сама `DigestService.build`, інша точка входу (див. [0014](0014-calendar-sync.md)).
- **Вечірній підсумок**, тижневий огляд: той самий механізм, інша джоба.
- **Кнопки під звітом** (Готово/Відкласти на пункт). Звіт v1 - лише текст.
- **Природномовне керування** ("вимкни звіт"). Лише `/digest`.
- **Повтор невдалої відправки** і наздоганяння пропущеного дня.
