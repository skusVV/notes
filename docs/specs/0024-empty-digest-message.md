---
id: 0024-empty-digest-message
state: IN-TESTING
attempt: 0
max_attempts: 3
branch: feat/0024-empty-digest-message
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: empty-day-sends
    assert: "From user 900000004 POST '/digest on' (X-Test-Now=2027-03-15T06:00:00+02:00); a '/export' from 900000004 shows no reminder whose eventAt falls on 2027-03-15 (if one does, use the next day with none and shift both X-Test-Now values to it). POST /ingest/digest (valid X-Ingest-Secret) with body {\"userId\":900000004} and X-Test-Now=2027-03-15T07:00:00+02:00 returns HTTP 200 with sent == true, and replies contains exactly one string; that string's first line is 'Доброго ранку! Сьогодні 15 березня.' and it contains a line exactly equal to 'На сьогодні нічого немає: ні нагадувань, ні нових даних. Гарного дня! ☀️'"
  - id: empty-day-claims
    assert: "Continuing from empty-day-sends: the same POST /ingest/digest again with the same X-Test-Now returns HTTP 200 with sent == false, reason == 'already_sent', and no string in replies"
  - id: non-empty-unchanged
    assert: "From user 900000005 POST '/digest on' and 'Remind me on March 16 2027 at 12:00 to buy bread' (X-Test-Now=2027-03-16T06:00:00+02:00). POST /ingest/digest with {\"userId\":900000005} and X-Test-Now=2027-03-16T07:00:00+02:00 returns sent == true; its reply starts with 'Доброго ранку! Сьогодні 16 березня.', contains 'bread' (case-insensitive), and does not contain 'На сьогодні нічого немає'"
  - id: disabled-unchanged
    assert: "From user 900000006 POST '/digest off'; POST /ingest/digest with {\"userId\":900000006} returns HTTP 200 with sent == false and reason == 'disabled', and no string in replies"
failures: []
---

# 0024 - Порожній ранковий звіт: коротке повідомлення замість тиші

> **READY 2026-11-24** (власник). Звичайний конвеєр (`/implement-spec`), перевірка по HTTP на тестовій
> функції.

## Context

Після [0022](0022-morning-run.md) ранкова джоба щодня о 07:00 викликає `POST /ingest/digest`. Якщо
всі розділи порожні (немає нагадувань, розділів Garmin ще немає), бот за
[0012](0012-morning-digest.md) не шле нічого і відповідає `reason: empty`. Власник побачив це на першому
ж запуску: тиша виглядає як поломка. Рішення власника: **порожній звіт не ігноруємо**, а шлемо коротке
дружнє повідомлення.

## Рішення

1. Коли всі розділи порожні, звіт складається з привітання (як зараз) і одного рядка, без маркера
   `• `:

   ```
   Доброго ранку! Сьогодні 24 листопада.

   На сьогодні нічого немає: ні нагадувань, ні нових даних. Гарного дня! ☀️
   ```

2. Такий звіт **займає день**, як звичайний: `users/{id}.digest.lastSentOn` ставиться в транзакції
   перед відправкою, повторний виклик того ж дня дає `already_sent`. Це міняє правило 0012 "порожній
   день нічого не займає".
3. Причина `empty` зникає з відповіді `/ingest/digest` (тип `DigestSkipReason` і коментарі). Решта
   причин (`disabled`, `already_sent`, `send_failed`) без змін.
4. Рядок - константа поруч із привітанням, без `parse_mode`, через `sendDigest` і чанкування.

## Scope

- `src/digest/digest.service.ts` - `build` повертає привітання + рядок порожнього дня, коли всі
  розділи порожні (або впали), замість `undefined`.
- `src/digest/digest-runner.service.ts` - прибрати гілку `empty`; тип `DigestSkipReason`.
- `src/ingest/ingest.controller.ts` - лише коментар зі списком причин.
- `test/` - оновити `digest.service.spec.ts`, `digest-runner.service.spec.ts` та інші, що чекали
  `empty`/`undefined`.
- `CLAUDE.md` - речення про `empty` в абзаці про ранковий звіт.

Поза межами: розділи звіту, `morning-run/`, час звіту, `/digest on|off`.

## Invariants (must not break)

- `disabled` перевіряється першим: користувач із вимкненим звітом не отримує нічого, навіть цього рядка.
- Не більше одного звіту на локальний день, також для порожнього.
- Не логувати текст звіту (лише user id, id розділів, кількість рядків).
- Розділ, що впав, не валить звіт: якщо впали всі, приходить рядок порожнього дня.
- `/ingest/digest`: ті самі `401`/`400`/`403` і завжди `200` після перевірок.

## Out of scope

Різні тексти на різні дні, персоналізація, вимкнення цього рядка окремою командою.
