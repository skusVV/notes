---
id: 0016-split-allowed-users
state: BLOCKED
attempt: 1
max_attempts: 3
branch: feat/0016-split-allowed-users
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: ingest-owner-is-first-allowed-id
    assert: "POST /ingest/message with a valid X-Ingest-Secret and body {\"text\":\"Нотатка: код від сейфа 7733\"} returns 200; a '/export' from U1 (900000001, the first id in the test allowlist) shows a stored note whose text contains 7733, and a '/export' from U2 (900000002) shows no note containing 7733"
  - id: ingest-no-secret
    assert: "POST /ingest/message without X-Ingest-Secret returns 401 and nothing is stored for U1"
  - id: ingest-wrong-secret
    assert: "POST /ingest/message with a wrong X-Ingest-Secret returns 401"
  - id: ingest-empty-text
    assert: "POST /ingest/message with a valid secret and body {\"text\":\"   \"} returns 400 with error == \"invalid_text\""
  - id: ingest-command-passthrough
    assert: "POST /ingest/message with a valid secret and body {\"text\":\"/version\"} returns 200 and replies contains a string matching /^notes-bot \\d+\\.\\d+\\.\\d+$/"
  - id: allowlist-still-gates
    assert: "POST a webhook update with text 'hello' from user id 900000007 (not in the test allowlist); the reflected reply is a refusal that contains the digits 900000007, and a '/export' from U1 is unchanged"
  - id: webhook-unchanged
    assert: "POST / with a wrong X-Telegram-Bot-Api-Secret-Token returns 401; with the right one, '/version' from U1 returns 200 and a reflected reply matching /^notes-bot \\d+\\.\\d+\\.\\d+$/"
failures:
  - attempt: 0
    stage: verification
    detail: >-
      Criterion conflict, not an implementation defect - needs the owner. Verified on the live test deploy
      of feat/0016-split-allowed-users (af5b6b8) on telegram-echo-bot-test; the deploy was proven live when
      POST /ingest/message with a valid X-Ingest-Secret flipped from 404 to 200 at 12:37 UTC. 7 of 8
      criteria PASS (health, ingest-owner-is-first-allowed-id: note YP1brMHmssw79gHOJTtZ with originalText
      'Нотатка: код від сейфа 7733' stored under U1 and none under U2, ingest-no-secret, ingest-wrong-secret,
      ingest-empty-text, ingest-command-passthrough, webhook-unchanged). allowlist-still-gates FAILS as
      written: a 'hello' update from 900000007 got the reflected reply 'Sorry, you are not allowed to use
      this bot.' (HTTP 200), which does not contain the digits 900000007; U1's /export was unchanged (that
      half passes). The refusal has not named the sender id since commit 3b89c3c ("remove user id from the
      error", 2026-08-22, already in main); this branch does not touch it, and README.md/CLAUDE.md still
      claim it does. Re-running the implementer cannot fix this without reversing that deliberate decision,
      which is outside this spec's scope. Owner decision needed - either amend the criterion to drop
      "contains the digits 900000007" (and fix the stale README/CLAUDE.md sentence), or restore the id in
      the refusal. Security checklist PASS.
---

# 0016 - Розділити ALLOWED_USERS на прод і тест; власник /ingest береться з нього

> **READY** (власник, 2026-11-01). Замінює рішення з [0013](0013-iphone-quick-capture.md), що власник
> `/ingest` живе в окремому `INGEST_USER_ID`. Залежить від 0013, змерджений у `main` разом із цим.

## Context

Прод і тестова функція читали **один** секрет `ALLOWED_USERS`, де лежали справжній id власника і шість
синтетичних тестових (`900000001`-`900000006`). Це змішування: тестові id були в дозволеному списку
проду, а власника `/ingest` довелося вказувати окремою змінною, бо зі спільного списку його не вибрати.

Цей спек розводить їх: у кожної функції **свій** список, а власником `/ingest` стає **перший id у
`ALLOWED_USERS`**. Окремий `INGEST_USER_ID` зникає. Для одного користувача це на один секрет менше.

## Рішення

1. **Два секрети замість одного спільного.** Прод читає `ALLOWED_USERS`, тест - `ALLOWED_USERS_TEST`, вибір
   через підстановку `_ALLOWED_USERS_SECRET_NAME` (за замовч. `ALLOWED_USERS`), як вже зроблено для інших
   секретів тесту.
2. **Власник `/ingest` - перший id списку.** Порядок записів у `ALLOWED_USERS` значущий, і це
   задокументовано в README та `.env.example`. У тестовому списку першим стоїть `900000001` (U1).
3. **Закрито за замовчуванням.** Список порожній, не заданий, або в ньому немає жодного коректного id:
   `/ingest` відповідає `401` (нічого не вгадується).
4. **`INGEST_USER_ID` видаляється повністю** з коду, `cloudbuild.yaml`, README, `.env.example`.
   Секрети `INGEST_USER_ID` / `INGEST_USER_ID_TEST` більше не потрібні.
5. **Гейт `ALLOWED_USERS` не змінюється.** Змінюється лише те, який список читає кожна функція, і те,
   звідки `/ingest` бере власника.

## Scope

- `src/telegram/telegram.service.ts` - публічний `ownerUserId(): number | undefined`: перший коректний id,
  розібраний тим самим `parseAllowedUsers`; порядок записів зберігається. Решту логіки не чіпати.
- `src/ingest/ingest.guard.ts` - власник береться з `TelegramService.ownerUserId()`; читання `INGEST_USER_ID` видалити.
- `src/ingest/ingest.module.ts` - лише якщо потрібен імпорт для ін'єкції.
- `test/ingest.guard.spec.ts`, `test/ingest.controller.spec.ts` - оновити під нове джерело власника;
  додати тест `ownerUserId` (перший id, порядок збережено, порожній/невалідний список дає `undefined`,
  пробіли й некоректні записи ігноруються).
- `cloudbuild.yaml` - `ALLOWED_USERS=${_ALLOWED_USERS_SECRET_NAME}:latest`; прибрати
  `INGEST_USER_ID=...` з `--set-secrets` і підстановку `_INGEST_USER_ID_SECRET_NAME`; додати
  `_ALLOWED_USERS_SECRET_NAME: ALLOWED_USERS` і в коментар для тригера `testing`
  `_ALLOWED_USERS_SECRET_NAME=ALLOWED_USERS_TEST`.
- `.env.example` - прибрати `INGEST_USER_ID`; біля `ALLOWED_USERS` пояснити, що перший id є власником `/ingest`.
- `README.md`, `CLAUDE.md` - оновити: два списки, перший id як власник, видалений `INGEST_USER_ID`; як
  скоротити прод-список до одного id (Console).
- `docs/specs/0013-iphone-quick-capture.md`, `0014-calendar-sync.md`, `0015-apple-health-sync.md` - у
  згадках `INGEST_USER_ID` написати "перший id у `ALLOWED_USERS`" (0013 додатково примітка, що рішення
  замінено цим спеком).

Поза межами без повернення в `DRAFT`: класифікатор, транскрипція, контракт вебхука і `/sweep`,
`docs/architecture.md`, зміст самого гейта `isAllowed`.

## Contracts

### `TelegramService.ownerUserId()`

```ts
/** Перший коректний id з ALLOWED_USERS у порядку запису, або undefined, якщо такого немає. */
ownerUserId(): number | undefined
```

### `IngestGuard.assertIngestSecret(received): number`

Повертає `ownerUserId()`; кидає `401`, якщо секрет відсутній/хибний, `INGEST_SECRET` не задано або
`ownerUserId()` дорівнює `undefined`. Інакше без змін відносно 0013.

### Конфігурація

| Змінна | Звідки | Зміст |
|---|---|---|
| `ALLOWED_USERS` | Secret Manager (`_ALLOWED_USERS_SECRET_NAME`) | Список id через кому. **Перший id - власник `/ingest`.** Прод: лише id власника. Тест: `900000001,...,900000006,<id власника>`. |

## Invariants (must not break)

- Гейт `ALLOWED_USERS` виконується перед будь-яким викликом моделі, як і раніше.
- `/ingest` закритий за замовчуванням: нічого не вгадується, якщо власника визначити не можна.
- Секрети порівнюються за сталий час; у логах лише довжини, не значення. Id в логах лише user id.
- Вебхук Telegram: `401` на хибний токен, інакше завжди `200`.

## Acceptance criteria (locked at READY)

Дзеркало frontmatter. Припущення: на тестовій функції `ALLOWED_USERS_TEST` = `900000001,900000002,
900000003,900000004,900000005,900000006,<id власника>` (U1 = 900000001, U2 = 900000002), `INGEST_SECRET_TEST`
задано, `TEST_REFLECT_REPLY=true`.

- **health**, **ingest-no-secret**, **ingest-wrong-secret**, **ingest-empty-text**,
  **ingest-command-passthrough**: як у 0013.
- **ingest-owner-is-first-allowed-id:** нотатка з `/ingest/message` потрапляє до U1 (першого в списку),
  а не до U2.
- **allowlist-still-gates:** id `900000007` (не в тестовому списку) отримує відмову.
- **webhook-unchanged:** вебхук Telegram поводиться як раніше.

## Out of scope

- Кілька власників чи вибір власника з тіла запиту.
- Правка прод-секрету `ALLOWED_USERS` (скорочення до одного id) - це ручний крок у Console, не код.
- Будь-які зміни гейта чи формату списку.
