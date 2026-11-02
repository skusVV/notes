---
id: 0023-digest-gaps
state: VERIFIED
attempt: 0
max_attempts: 3
branch: feat/0023-digest-gaps
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: birthday-shown-without-time
    assert: "With X-Test-Now=2026-10-14T06:00:00+03:00, from U1 POST '/digest on' and 'Bob has a birthday on October 14'; read the stored reminder from '/export': allDay == true and eventAt starts with '2026-10-14'. POST /ingest/digest (valid secret, userId 900000001) with X-Test-Now=2026-10-14T07:00:00+03:00 returns sent == true and replies contains exactly one string starting with 'Доброго ранку' that has a line equal to '• ' followed by the stored title, and that string contains neither '9:00' nor '09:00'"
  - id: timed-recurring-keeps-time
    assert: "With X-Test-Now=2026-10-14T06:00:00+03:00, from U2 POST '/digest on' and 'Remind me every day at 15:00 to stretch'; the stored reminder in '/export' has allDay == false (or the key absent) and eventAt starting with '2026-10-14T15:00'. POST /ingest/digest (userId 900000002) with X-Test-Now=2026-10-14T07:00:00+03:00: the 'Доброго ранку' reply contains the stored title and '15:00'"
  - id: done-removes-from-digest
    assert: "With X-Test-Now=2026-10-14T06:00:00+03:00, from U3 POST '/digest on' and 'Remind me today at 14:00 to call the dentist'; read the stored title and the notification id from '/export'. POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-10-14T13:45:00+03:00 so the notification is delivered (status 'sent'); POST a callback_query (valid webhook secret, from = U3) with data 'rem:ok:{notificationId}'; a '/export' from U3 shows that notification 'acked' and the reminder status == 'acked'. POST /ingest/digest (userId 900000003) with X-Test-Now=2026-10-14T14:10:00+03:00 returns sent == false, reason == \"empty\", and no reply contains the stored title"
  - id: sent-not-done-stays
    assert: "With X-Test-Now=2026-10-14T06:00:00+03:00, from U5 POST '/digest on' and 'Remind me today at 14:00 to buy bread'; read the stored title from '/export'. POST /sweep with X-Test-Now=2026-10-14T13:45:00+03:00 (the notification becomes 'sent', nobody presses Done). POST /ingest/digest (userId 900000005) with X-Test-Now=2026-10-14T14:10:00+03:00 returns sent == true and its 'Доброго ранку' reply contains the stored title; the reminder in '/export' still has status == 'scheduled'"
  - id: recurring-done-keeps-reminder
    assert: "With X-Test-Now=2026-10-14T06:00:00+03:00, from U6 POST 'Remind me every day at 15:00 to take vitamins'; read the stored notification id from '/export'. POST /sweep with X-Test-Now=2026-10-14T14:45:00+03:00 (delivered, next occurrence armed), then POST a callback_query (from = U6) with data 'rem:ok:{notificationId}'; a '/export' from U6 shows that notification 'acked', the reminder status still == 'scheduled', and exactly one notification with status 'scheduled' at 2026-10-15T15:00:00+03:00"
failures: []
---

# 0023 - Ранковий звіт: дні народження без часу, виконане зникає зі звіту

> **Критерії зафіксовано** (власник, `READY`, 2026-11-02). Дві прогалини, знайдені під час
> реалізації [0012](0012-morning-digest.md). Залежить від 0012, змерджений у `main`.

## Context

Після 0012 у проді звіт має два дефекти:

1. **День народження показується як "о 09:00".** Повторюване нагадування без часу отримує типові 09:00,
   але ніщо не позначає, що час не називали. Розділ вміє показувати подію без часу (`allDay`), та поле
   ніхто не пише.
2. **Виконане нагадування лишається у звіті.** Кнопка "Готово" позначає лише *сповіщення* (`acked`), а
   статус самого нагадування завжди `scheduled`, тож фільтр розділу нічого не прибирає.

## Рішення, прийняті в цьому спеку

1. **`allDay` ставить код, не модель, і лише коли час не названо.** Нагадування стає `allDay: true`, якщо
   воно **повторюване** і класифікатор повернув `hasTimeOfDay === false`. Одноразове нагадування без
   часу й далі йде в уточнення (як зараз), тож `allDay` у нього ніколи не буває. Відсутнє `hasTimeOfDay`
   - не `false`: не вгадуємо.
2. **Лише нові нагадування.** Уже збережені дні народження (без `allDay`) не мігруємо: 09:00, яке
   назвав користувач, неможливо відрізнити від типових. Вони показуватимуть час, доки їх не створити
   наново.
3. **Нагадування виконане, коли в нього не лишилось сповіщень зі статусом `scheduled` чи `sent`.**
   Після "Готово" на сповіщенні: якщо інших таких немає - нагадування отримує `status: 'acked'` і
   `ackedAt`. Нагадування з двома сповіщеннями ("ввечері перед" і "вранці в день") лишається, доки не
   виконано обидва. Повторюване нагадування після "Готово" **не** закривається: наступний випадок уже
   має сповіщення `scheduled`.
4. **Доставлене, але не відмічене - лишається у звіті** (як у 0012).
5. **Подія без часу в звіті йде першою**, далі за часом. Рядок - лише назва, без часу.

## Scope

- `src/classifier/classifier.types.ts` - `ReminderDraft.allDay?: boolean`.
- `src/classifier/classifier.service.ts` - `coerceItem` виставляє `allDay: true`, коли `recurrence` валідна і
  `reminder.hasTimeOfDay === false`; інакше поле відсутнє. Промпт і схему не міняти.
- `src/telegram/telegram.service.ts` - передати `allDay` у `reminders.create`.
- `src/reminders/reminders.service.ts` - `ReminderDraftInput.allDay?`; `create` пише `allDay: true` на
  документ нагадування (лише для повторюваного); `ReminderExport.allDay: boolean` у `/export`;
  `ackNotification` закриває нагадування за правилом 3.
- `src/reminders/reminders-digest.section.ts` - події без часу першими.
- `test/` - оновити/додати тести (нижче).
- `CLAUDE.md` - одне речення в абзаці про звіт.

Поза межами без повернення в `DRAFT`: промпт класифікатора, `SweeperService`, `/sweep`, текст доставки
нагадування, міграція старих даних, нові Firestore-індекси (запит "сповіщення зі статусом `scheduled` або
`sent`" - одне поле, автоіндекс).

## Contracts

- Документ нагадування: `allDay: true` лише для повторюваного без названого часу; інакше поля немає.
  Накат наступного випадку (`enqueueNextOccurrence`) змінює лише `eventAt`/`eventAtUtc`, тож `allDay`
  зберігається сам.
- `/export`: кожне нагадування має `allDay: boolean` (`false`, якщо поля немає).
- `ackNotification(ref, userId, now)`: оновити сповіщення, потім прочитати сповіщення цього нагадування
  зі статусом `scheduled` чи `sent` (`limit(1)`); порожньо - оновити нагадування
  (`status: 'acked'`, `ackedAt`). Збій цього другого кроку логується (лише id), не кидається: "Готово"
  вже зафіксовано на сповіщенні.
- Лог без назв і тексту нагадувань, лише id.

## Invariants (must not break)

- Вебхук `200` усюди, крім хибного секрету; збій - у лог.
- `ALLOWED_USERS` і перевірка власника callback - перед будь-якою дією.
- Нічого не вгадуємо: без `hasTimeOfDay === false` поле `allDay` не пишемо.
- Нагадування, у якого ще є сповіщення `scheduled` чи `sent`, не закривається.
- Жодного сирого ISO у чаті; без `parse_mode`; без логування змісту.
- `/sweep`, класифікаторний промпт і текст доставки не змінюються.

## Acceptance criteria (locked at READY)

Дзеркало frontmatter. Користувачі - U1-U6 (`900000001`-`900000006`), дата тесту 2026-10-14 (не збігається з
датами 0012). Заголовок і id сповіщення читаються з `/export`, не вгадуються.

- **birthday-shown-without-time** - день народження без часу: `allDay == true`, у звіті лише назва.
- **timed-recurring-keeps-time** - повторюване з названим часом `allDay` не має, у звіті є `15:00`.
- **done-removes-from-digest** - після доставки й "Готово" нагадування `acked` і зі звіту зникає.
- **sent-not-done-stays** - доставлене, але не відмічене, лишається у звіті.
- **recurring-done-keeps-reminder** - "Готово" на повторюваному не закриває нагадування, наступний
  випадок на місці.

Юніт-тести (детерміновані): `coerceItem` (`allDay` лише при валідній recurrence і `hasTimeOfDay === false`;
одноразове ніколи; `hasTimeOfDay` відсутнє - поля немає); `create` пише `allDay` лише для такого
повторюваного; `ackNotification` (єдине сповіщення - нагадування `acked`; два сповіщення, одне виконано -
лишається `scheduled`; сповіщення `sent` блокує закриття; повторюване з наступним `scheduled` не
закривається; збій другого кроку не кидає); розділ нагадувань (події без часу першими, далі за часом;
рядок без часу).

## Out of scope

- Міграція вже збережених днів народження.
- Показ "весь день" у тексті доставки самого нагадування.
- Позначка "виконано" у звіті замість зникнення.
- Звіт про сповіщення сьогодні для події іншого дня.
