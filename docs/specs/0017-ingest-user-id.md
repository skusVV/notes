---
id: 0017-ingest-user-id
state: READY
attempt: 0
max_attempts: 3
branch: feat/0017-ingest-user-id
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: ingest-no-secret
    assert: "POST /ingest/message without X-Ingest-Secret, body {\"userId\":900000001,\"text\":\"Нотатка: маркер 5501\"}, returns 401 and a '/export' from U1 (900000001) shows no note containing 5501"
  - id: ingest-wrong-secret
    assert: "POST /ingest/message with a wrong X-Ingest-Secret and a valid body returns 401"
  - id: ingest-missing-userid
    assert: "POST /ingest/message with a valid secret and body {\"text\":\"Нотатка: маркер 5502\"} (no userId) returns 400 with error == \"invalid_user\"; no note containing 5502 exists for U1 or U2 (900000002)"
  - id: ingest-bad-userid
    assert: "POST /ingest/message with a valid secret and userId set to \"abc\", then 0, then -5, then 1.5, each with text 'Нотатка: маркер 5503', returns 400 with error == \"invalid_user\" every time and stores nothing"
  - id: ingest-userid-not-allowed
    assert: "POST /ingest/message with a valid secret and body {\"userId\":900000007,\"text\":\"Нотатка: маркер 5504\"} (900000007 is not in the test allowlist) returns 403 with error == \"user_not_allowed\", the response has no 'replies', and U1's '/export' is identical before and after"
  - id: ingest-empty-text
    assert: "POST /ingest/message with a valid secret, userId 900000001 and body text \"   \" returns 400 with error == \"invalid_text\""
  - id: ingest-note-per-user
    assert: "POST /ingest/message with a valid secret: first {\"userId\":900000001,\"text\":\"Нотатка: код від сейфа 7733\"}, then {\"userId\":900000002,\"text\":\"Нотатка: код від гаража 8844\"}; both return 200. A '/export' from U1 shows a stored note containing 7733 and none containing 8844; a '/export' from U2 shows a stored note containing 8844 and none containing 7733"
  - id: ingest-userid-as-string
    assert: "POST /ingest/message with a valid secret and body {\"userId\":\"900000002\",\"text\":\"Нотатка: код від шафи 9955\"} (userId as a digit string) returns 200 and a '/export' from U2 shows a stored note containing 9955, none for U1"
  - id: ingest-command-passthrough
    assert: "POST /ingest/message with a valid secret and body {\"userId\":900000001,\"text\":\"/version\"} returns 200 and replies contains a string matching /^notes-bot \\d+\\.\\d+\\.\\d+$/"
  - id: webhook-unchanged
    assert: "POST / with a wrong X-Telegram-Bot-Api-Secret-Token returns 401; with the right one, '/version' from U1 returns 200 and a reflected reply matching /^notes-bot \\d+\\.\\d+\\.\\d+$/"
failures: []
---

# 0017 - `/ingest/message` приймає `userId` у тілі: застосунок для кількох людей

> **READY.** Замінює рішення 0016, що власник `/ingest` - перший id у `ALLOWED_USERS`. Залежить від
> 0013 і 0016, обидва в `main`. **Після цього деплою поточна команда на телефоні перестане працювати,
> доки в тіло не додати `userId`** (див. "Налаштування на телефоні").

## Context

0013 і 0016 вважали, що бот один і має одного власника. Це не так: бот має обслуговувати кількох людей.
Тепер **телефон сам вказує, від чийого імені надіслано текст**, полем `userId` у тілі. Бот перевіряє два
замки: спільний секрет (`X-Ingest-Secret`) і те, що цей id є в `ALLOWED_USERS`. Відповідь іде в чат цієї
людини (у приватному чаті id чату дорівнює id користувача).

Рішення власника (2026-11-01): **один спільний секрет плюс `userId` у тілі**, не окремий токен на людину.

## Рішення

1. **`userId` обов'язковий.** Без нього `400`. Мовчазного "дефолтного власника" немає: інакше текст
   людини, що забула поле, тихо опинився б у чужих нотатках.
2. **Порядок перевірок.** Секрет (`401`) -> тіло: `text` (`400 invalid_text`), `userId` (`400 invalid_user`)
   -> гейт `ALLOWED_USERS` (`403 user_not_allowed`) -> обробка.
3. **Недозволений користувач не отримує нічого.** `403` повертається без виклику моделі і **без**
   повідомлення в Telegram цій людині (гейт працює до будь-якої роботи, як і для вебхука).
4. **Закрито за замовчуванням.** Секрет не заданий, або `ALLOWED_USERS` порожній/не заданий: `401`. Інакше
   відкритий список дозволив би кожному, хто знає секрет, писати від імені будь-кого.
5. **`userId` - додатне ціле, число або рядок із цифр.** iOS-команди часто віддають значення рядком.
   `0`, від'ємні, дробові, нечислові - `400 invalid_user`.
6. **Порядок записів у `ALLOWED_USERS` знову не має значення.** Правило "перший id - власник" (0016)
   скасовується; `ownerUserId()` видаляється.
7. **Ризик, прийнятий свідомо:** хто має спільний секрет, може писати від імені будь-якого дозволеного
   користувача. Тому секрет не слід розшарювати за межі довіреного кола.

## Scope

- `src/ingest/ingest.guard.ts` - лише перевірка секрету і наявності списку; **не повертає власника**.
- `src/ingest/ingest.controller.ts` - читання `userId` з тіла, валідація, перевірка дозволу, виклик
  `handleIngestedText(userId, ...)`.
- `src/telegram/telegram.service.ts` - публічні `isAllowedUserId(id): boolean` (той самий список, що й
  гейт) і `hasAllowlist(): boolean`; **видалити** `ownerUserId()`. Решту логіки не чіпати.
- `test/ingest.guard.spec.ts`, `test/ingest.controller.spec.ts` - переписати під нову поведінку: усі відповіді
  `400/401/403`, `userId` рядком і числом, відсутній/нечисловий/нуль/від'ємний/дробовий, порожній список
  дає `401`, для двох різних `userId` синтетичне оновлення має різні `from.id` і `chat.id`; тест, що
  `403` не викликає `handleUpdate` і нічого не надсилає.
- `README.md` - розділ "iPhone: швидка нотатка": додати поле `userId` у тіло, як дізнатися свій id, таблицю
  відповідей з `400 invalid_user` і `403`; прибрати згадки "перший id - власник".
- `CLAUDE.md`, `.env.example` - те саме: прибрати правило першого id.
- `docs/specs/0013-iphone-quick-capture.md`, `0016-split-allowed-users.md` - примітка, що власника замінює
  `userId` з тіла (0017). `0014-calendar-sync.md`, `0015-apple-health-sync.md` - примітка, що їхні
  ендпоінти теж беруть `userId` з тіла так само, як тут.

Поза межами без повернення в `DRAFT`: класифікатор, транскрипція, вебхук Telegram, `/sweep`, формат
`ALLOWED_USERS`, `cloudbuild.yaml` (нових секретів і змінних немає), `docs/architecture.md`.

## Contracts

### `POST /ingest/message`

Заголовки: `X-Ingest-Secret`, `Content-Type: application/json`. Тіло:

```json
{ "userId": 281473866, "text": "Нотатка: перевірка зв'язку" }
```

| Ситуація | Відповідь |
|---|---|
| секрет відсутній/хибний, `INGEST_SECRET` не заданий, або `ALLOWED_USERS` порожній/не заданий | `401`, нічого не оброблено |
| `text` відсутній, не рядок, порожній після `trim`, або довший за 4000 символів | `400` `{ "ok": false, "error": "invalid_text" }` |
| `userId` відсутній або не додатне ціле (число чи рядок із цифр) | `400` `{ "ok": false, "error": "invalid_user" }` |
| `userId` не входить до `ALLOWED_USERS` | `403` `{ "ok": false, "error": "user_not_allowed" }`, у Telegram нічого не надіслано |
| інакше | `200` `{ "ok": true }`; збій обробки після валідації теж `200`, залогований |

Якщо і `text`, і `userId` некоректні, повертається помилка `invalid_text` (перевірка тексту йде першою).

На тестовій функції (`TEST_REFLECT_REPLY=true`) відповідь `200` також має `replies` і шанує `X-Test-Now`,
як раніше. У `403` поля `replies` немає.

### `TelegramService`

```ts
isAllowedUserId(id: number): boolean   // true, якщо id є в ALLOWED_USERS
hasAllowlist(): boolean                // false, якщо список порожній або не заданий
```

`handleIngestedText(userId, text, sink?, nowOverride?)` без змін за сигнатурою; `userId` тепер береться з тіла.

## Налаштування на телефоні (оновити в README)

У команді "Нотатка" тіло запиту стає JSON з **двома** полями:

- `userId` - твій Telegram id цифрами (як його знайти: написати боту і прочитати `Received message from user
  <id>` у Cloud Logging, або `@userinfobot`). У команді, яку збирає інша людина, стоїть її id.
- `text` - змінна "Диктований текст".

Після деплою команда без `userId` отримає `400 invalid_user`: це нагадування оновити тіло.

## Invariants (must not break)

- Гейт `ALLOWED_USERS` виконується **до** будь-якого виклику моделі і до будь-якого повідомлення в Telegram.
- Секрет порівнюється за сталий час; у логах лише довжини. Тексти та `userId` у логах: лише `userId`.
- Закрито за замовчуванням: нічого не вгадується, якщо секрет чи список не налаштовані.
- Вебхук Telegram: `401` на хибний токен, інакше `200`.
- Відповіді без `parse_mode`; усе, що надсилається, іде через `sendMessage` з чанкуванням.

## Acceptance criteria (locked at READY)

Дзеркало frontmatter. Припущення верифікатора: `ALLOWED_USERS_TEST` = `900000001`...`900000006` і id власника;
`INGEST_SECRET_TEST` береться з `TEST_INGEST_SECRET`; U1 = 900000001, U2 = 900000002; тест-функція має
`TEST_REFLECT_REPLY=true`. Маркери в нотатках унікальні, щоб дані попередніх прогонів не заважали.

## Out of scope

- Окремий токен на людину, ротація секрету по людях.
- `/ingest/voice`, share sheet: окремі спеки.
- Реєстрація нових користувачів через бота: список `ALLOWED_USERS` правиться вручну в Secret Manager.
- Обмеження частоти запитів на користувача.
