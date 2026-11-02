---
id: 0022-morning-run
state: DRAFT
attempt: 0
max_attempts: 3
branch: feat/0022-morning-run
delivery: manual
acceptance: []
failures: []
---

# 0022 - Ранкова джоба: синк Garmin з ретраями, потім звіт

> **DRAFT, delivery: manual** (як [0010](0010-garmin-health-sync.md)): це окремий сервіс із зовнішнім
> ключем Garmin, його не ганяє `/implement-spec`. Критерії нижче - ручні, на твоїх реальних даних.
> **Залежить від** [0010](0010-garmin-health-sync.md) (код ingester-а вже є) **і** від ендпоінта
> `POST /ingest/digest` зі спека [0012](0012-morning-digest.md), змерджених у `main` і задеплоєних.

## Context

Зараз `garmin-ingester` біжить о 07:00, нічого не знає про звіт і при тимчасовому збої Garmin просто
виходить. Ти встаєш між 6 і 7, тож синк о 06:00 міг би не побачити сон, а звіт, не пов'язаний із
синком, міг би вийти зі старими даними.

Рішення власника (2026-11-02): **одна джоба, один Scheduler о 07:00.** Джоба тягне Garmin (кілька
спроб), а потім просить бота надіслати звіт. Якщо після всіх спроб Garmin нічого не дав, звіт іде без
Garmin. Бот і далі єдине місце, де звіт збирається (розділи, нагадування, Telegram); джоба лише
запускає його.

## Рішення, прийняті в цьому спеку

1. **Один запуск = синк (до N спроб) -> виклик бота.** Виклик бота робиться **завжди**, також після
   збою Garmin, відхиленого ключа і навіть після неочікуваної помилки у фазі Garmin.
2. **Спроба вважається вдалою, коли Garmin відповів і за сьогодні є сон.** `health_daily/{сьогодні}`
   з `sleep.seconds != null`. Порожній сон не є помилкою (Garmin віддає `200` і `[]`), але це якраз випадок
   "годинник ще не синхронізувався з телефоном", тож його теж повторюємо.
3. **Ретраїмо лише те, що може минути:** тимчасову помилку (`GarminTransientError`, мережа, `429`, `5xx`) і
   "сну ще немає". Відхилений ключ (`GarminAuthError`) **не** ретраїмо: наступні спроби безглузді.
4. **Алерт-стан рахується один раз на запуск, з підсумкового результату**, не на кожну спробу. Правила
   [0010](0010-garmin-health-sync.md) ("notify only on state change") не змінюються. Фініш "Garmin
   відповів, але сну нема" - це `success`, не `transient`.
5. **Час звіту = час запуску Scheduler.** Звіт приходить одразу після останньої спроби: у хорошому
   випадку о ~07:00, у найгіршому о ~07:12. Командою час не міняється ([0012](0012-morning-digest.md)).
6. **Перейменування:** директорія `garmin-ingester/` -> `morning-run/`, Cloud Run job `garmin-ingester` ->
   `morning-run`, образ так само. Назва більше не бреше: це не лише Garmin.

## Scope

- `git mv garmin-ingester morning-run` і оновити всі посилання: `.gcloudignore`, `cloudbuild.yaml`
  (образ, `_JOB_NAME`, шляхи), `README.md`, `Dockerfile`, посилання з інших спеків
  ([0010](0010-garmin-health-sync.md), [0018](0018-digest-garmin-sections.md)).
- `morning-run/src/ingester.ts` - цикл спроб, `finally` з викликом бота (розбити на функції, якщо
  виросте; `main` не повинен сам рахувати спроби).
- `morning-run/src/retry-plan.ts` - **новий.** Чиста функція `shouldRetry(outcome, hasSleepToday,
  attempt, maxAttempts)` і `finalOutcome(...)`. Без годинника, без мережі.
- `morning-run/src/bot-client.ts` - **новий.** `requestDigest(baseUrl, secret, userId)`: `POST
  /ingest/digest`, до 3 спроб на мережу/`5xx` з паузою 5 с, ніколи не логує секрет і тіло відповіді.
- `morning-run/src/*.test.ts` - тести `retry-plan` і `bot-client` (підставний `fetch`).
- `morning-run/cloudbuild.yaml` - `--task-timeout=1800s`, `INGEST_SECRET` у `--set-secrets`,
  `BOT_BASE_URL` та нові змінні (див. нижче).
- `README.md` (корінь) і `morning-run/README.md` - Console click-path для переходу (нижче).

Поза межами без повернення в `DRAFT`: код бота (`src/`), `garmin-client.ts` (крім імпортів), формат
Firestore-документів, правила алертів, [0012](0012-morning-digest.md) і [0018](0018-digest-garmin-sections.md).

## Contracts

### Цикл запуску

```
attempt = 1
loop:
  result = syncOnce()              // як зараз: ключ -> дані -> запис у Firestore
  if auth_rejected: stop loop
  if success і сон за сьогодні є: stop loop
  if attempt == MORNING_MAX_ATTEMPTS: stop loop
  sleep MORNING_RETRY_PAUSE_SECONDS; attempt += 1
final = finalOutcome(last result)
decide(alert-state, final)         // рівно один раз, як у 0010
requestDigest(...)                 // у finally, завжди
exit 0
```

- Кожна спроба переписує ті самі документи (`health_daily` за датою, `activities` за id), тож повтор
  ідемпотентний ([0010](0010-garmin-health-sync.md)).
- **Підсумковий результат** (`finalOutcome`): `auth_rejected`, якщо ключ відхилено; інакше `transient`,
  якщо остання спроба не дістала відповіді від Garmin; інакше `success` (також коли сну немає).
- Найгірший випадок часу: `(N - 1) * пауза` = 4 * 180 с = **12 хв** паузи плюс час самих запитів.
- Код виходу `0` завжди, якщо джоба дійшла до виклику бота. `1` лише при падінні процесу (Cloud Run job
  ретраїв не має: `--max-retries=0`, бо повторний запуск ударив би по Garmin і по звіту).

### Виклик бота

`POST ${BOT_BASE_URL}/ingest/digest`, заголовок `X-Ingest-Secret: ${INGEST_SECRET}`,
`Content-Type: application/json`, тіло `{"userId": <GARMIN_OWNER_USER_ID>}`.

- `200` з будь-яким `sent`/`reason` - кінець. Це не помилка джоби: `disabled`, `empty`, `already_sent`
  легітимні. У лог іде лише `status` і `reason` (без тексту звіту, його й так немає у відповіді).
- `401`, `400`, `403` - не повторювати, залогувати код (це помилка конфігурації).
- Мережа, `5xx`, таймаут - до 3 спроб з паузою 5 с. Повтор безпечний: бот не шле двічі (`lastSentOn`).
- Збій виклику не перетворює запуск у падіння: залогувати, код виходу `0`.

### Конфігурація (нове)

| Змінна | Джерело | Зміст |
|---|---|---|
| `INGEST_SECRET` | Secret Manager, `:latest` (секрет уже існує для бота) | Той самий `X-Ingest-Secret`. Джобі потрібен лише **Secret Accessor**. |
| `BOT_BASE_URL` | env var | Адреса prod-функції бота без `/` в кінці. Не секрет. |
| `MORNING_MAX_ATTEMPTS` | env var, за замовч. `5` | Спроб синку за запуск. |
| `MORNING_RETRY_PAUSE_SECONDS` | env var, за замовч. `180` | Пауза між спробами. |

Решта змінних - як у [0010](0010-garmin-health-sync.md). `BACKFILL_DAYS=1` лишається: кожна спроба
перетягує вчора й сьогодні.

**Увага до `cloudbuild.yaml`:** там зараз `--set-env-vars=...`. Для Cloud Run jobs цей прапорець **замінює
всі** змінні, тож `GARMIN_OWNER_USER_ID` і `GARMIN_KEY_EXPIRES_ON`, поставлені в Console, могли б
зникнути після деплою (коментар у файлі стверджує протилежне). Імплементатор мусить перевірити це на
реальній джобі й, якщо так, перейти на `--update-env-vars`. Нові змінні - теж через `--update-env-vars`.

## Invariants (must not break)

Усі інваріанти [0010](0010-garmin-health-sync.md) лишаються, зокрема: ключ і токен не покидають Secret
Manager і пам'ять і не логуються; `GARMIN_API_KEY` лише читається; нічого не логуються значення здоров'я;
нотифікація лише на зміну стану; ідемпотентність; не ламати деплой бота. Додатково:

- **Виклик бота завжди, один раз за запуск** (з мережевими повторами всередині). Зламаний Garmin не
  скасовує звіт.
- **Алерт на запуск рівно один раз**, не по разу на спробу.
- **`INGEST_SECRET` ніколи не логується і не потрапляє в Firestore чи Telegram.**
- **Відхилений ключ не ретраїться.**
- **Не більше `MORNING_MAX_ATTEMPTS` спроб за запуск**, незалежно від типу помилки.
- Запуск вкладається в `--task-timeout` з запасом: `1800s` проти найгіршого ~12 хв плюс запити.
- Бот не змінюється цим спеком.

## Acceptance criteria (manual - the pipeline cannot run these)

Запускати локально з реальним ключем проти `notes` Firestore та тестової або prod-функції бота.
`acceptance` у frontmatter порожнє: автоматичного верифікатора для цього треку немає.

- **retry-plan-unit:** юніт-тести `retry-plan` зелені: transient -> повтор; success без сну -> повтор;
  success зі сном -> стоп; `auth_rejected` -> стоп без повтору; `attempt == max` -> стоп.
- **retries-on-missing-sleep:** з `MORNING_MAX_ATTEMPTS=3` і `MORNING_RETRY_PAUSE_SECONDS=5`, коли за
  сьогодні сну ще нема (напр. рано вранці до синку годинника), лог показує рівно 3 спроби, а потім виклик
  бота; рядок підсумку каже `outcome: success`, а не `transient`.
- **stops-early-on-success:** коли сон є, лог показує рівно 1 спробу.
- **auth-rejected-no-retry:** з хибним `GARMIN_API_KEY` лог показує 1 спробу, **один** алерт у Telegram,
  і виклик бота все одно відбувся.
- **garmin-down-digest-still-sent:** з вимкненою мережею до Garmin (напр. хибний хост у тестовій
  змінній) після всіх спроб бот отримує виклик і звіт приходить без розділів Garmin; жодного алерта про
  відхилений ключ немає.
- **digest-call-ok:** виклик на live-бота з увімкненим `/digest on` дає лог `status 200`, `sent: true`;
  повторний запуск того ж дня дає `reason: already_sent`, і в Telegram нічого нового не приходить.
- **bot-errors-do-not-crash:** з хибним `INGEST_SECRET` лог показує `401` без повтору, код виходу `0`.
- **no-secret-in-logs:** у логах немає ні `INGEST_SECRET`, ні ключа, ні токена, ні значень здоров'я.
- **timing:** на реальному запуску о 07:00 звіт приходить не пізніше ~07:15 і містить сон, коли годинник
  синхронізований.

## Console setup (click-paths, per CLAUDE.local.md)

Локальних `gcloud` write-команд не потрібно. Порядок такий, щоб звіт не пропав між старою й новою
джобою:

1. **Secret Manager -> `INGEST_SECRET` -> Permissions -> Grant access:** сервісний акаунт джоби,
   роль **Secret Manager Secret Accessor**.
2. **Cloud Build -> Triggers:** тригер ingester-а -> Edit -> **Configuration** -> Location:
   `morning-run/cloudbuild.yaml`; **Included files filter** змінити на `morning-run/**`. Save.
3. Запушити перейменування. Тригер створить нову Cloud Run job `morning-run` (старий `garmin-ingester`
   лишається, поки нічого не видалено).
4. **Cloud Run -> Jobs -> `morning-run` -> Edit -> Variables & Secrets:** переконатися, що є
   `GARMIN_OWNER_USER_ID`, `GARMIN_KEY_EXPIRES_ON`, `GCP_PROJECT`, `FIRESTORE_DATABASE`, а також додати
   `BOT_BASE_URL` (адреса prod-функції) і за потреби `MORNING_MAX_ATTEMPTS` / `MORNING_RETRY_PAUSE_SECONDS`.
   **Container -> Task timeout:** `1800` с. **Max retries:** `0`.
5. **Run once** вручну (Execute) і перевірити в **Logs**: спроби, виклик бота, звіт у Telegram.
6. **Cloud Scheduler:** задання, що запускало `garmin-ingester` -> Edit -> target - job `morning-run`;
   розклад `0 7 * * *`, `Europe/Kyiv`. Save, **Force run** для перевірки.
7. Лише після успішного кроку 6: **Cloud Run -> Jobs -> `garmin-ingester` -> Delete**. Старий
   Scheduler більше не потрібен, якщо ви створили новий замість зміни старого.

Щоб змінити час звіту: **Cloud Scheduler -> задання -> Edit -> Frequency** (наприклад `30 7 * * *`).
Командою в чаті це не робиться.

## Out of scope

- Будь-яка зміна логіки звіту чи розділів (це [0012](0012-morning-digest.md) і [0018](0018-digest-garmin-sections.md)).
- Звіт на кількох користувачів: Personal API однокористувацький, джоба обслуговує одного власника.
- Наздоганяння пропущеного дня: якщо джоба цілком не запустилась, звіту того дня немає.
- Вечірня джоба й тижневі огляди (той самий механізм, інші Scheduler-задання).
- Заміна Cloud Scheduler чимось розумнішим (адаптивний запуск після синку годинника).
