---
id: 0009-remind-me-filed-as-note
state: READY
severity: high
attempt: 0
max_attempts: 3
branch: fix/0009-remind-me-filed-as-note
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "Three times, each from a fresh state: POST a webhook text update from user 900000004 with X-Test-Now=2026-10-25T20:27:00+02:00 and text 'Нагадай мені завтра десь о 1:00 годині дня, що я працював над додатком е-е для годиннику і сьогодні ввечері о 20:23 він мені дав якесь дивне сповіщення без тексту.'. After each, /export from 900000004 contains a reminder whose originalText equals that text and whose eventAt is 2026-10-26T13:00:00+02:00, and notes[] contains no entry whose originalText equals that text. 3 of 3 runs pass. (Delete the stored reminder between runs, or use the reminder count: exactly one new reminder per run.)"
  - id: note-unchanged
    assert: "POST a webhook text update from user 900000004 with text 'Цікава думка: годинник краще заряджати вночі.'; /export from 900000004 then contains a note whose originalText equals that text, and no reminder whose originalText equals it"
  - id: regression-test
    assert: "npm test passes and includes a regression test that fails on the pre-fix code, asserting the classifier prompt states that an explicit request to be reminded (нагадай / нагадуй / remind me / напомни) is always a reminder item, with the content after що/about/to as its title even when it describes the past"
failures: []
---

# BUG-0009 - Явне "Нагадай мені..." збережено як нотатку

> **READY 2026-11-26** (owner: "fix bug 0009"). **OPEN** (2026-11-25). Знайдено в прод-даних власника. Перед `READY` треба відтворити на тестовій
> функції (крок Reproduction), бо прод-логи за 2026-10-25 вже видалено (зберігання 30 днів).

## Symptom

Власник надиктував *"Нагадай мені завтра десь о 1:00 годині дня, що я працював над додатком е-е для
годиннику і сьогодні ввечері о 20:23 він мені дав якесь дивне сповіщення без тексту."* Бот зберіг це
як **нотатку** (`summary` без слова "нагадай"), нагадування не створилось і не спрацювало. Нотатку
видалено з проду вручну 2026-11-25.

## Reproduction

На тестовій функції при `X-Test-Now=2026-10-25T20:27:00+02:00` надіслати від U4 (900000004) текст вище
(можна текстом, не голосом). Очікувано-хибно сьогодні: у `/export` від U4 з'являється запис у `notes`
і немає reminder на 2026-10-26 13:00. Повторити 3 рази (`temperature: 0`, але перевірити стабільність).

## Root cause

**Гіпотеза, не підтверджено** (логи класифікації того дня не збереглися). У
[classifier.service.ts](../../src/classifier/classifier.service.ts) `INTENT_GUIDE` визначає `note` як
"The default for anything worth keeping", а `reminder` як "something to be reminded about later".
Явного правила "дієслово-тригер `нагадай / remind me` = завжди `reminder`, а текст після `що` /
`about` - його title" немає. Зміст повідомлення - опис минулої події ("я працював", "він дав
сповіщення"), і модель, ймовірно, класифікувала за змістом, а не за проханням.

Якщо відтворення не провалюється на поточному коді - записати це сюди і закрити баг як не
відтворений, лише з доданим промпт-правилом, якщо власник захоче.

## Fix scope

- `src/classifier/classifier.service.ts` - правило в промпті: явне прохання нагадати (`нагадай`,
  `нагадуй`, `remind me`, `напомни`) завжди дає item `reminder`; зміст після `що`/`about`/`to` - title,
  навіть якщо описує минуле.
- `test/` - регресійний тест на промпт (правило присутнє) і на `coerceItem` для такого прикладу.

## Invariants (must not break)

- `temperature: 0`, structured output; поганий payload -> `fallbackResult`, не 500.
- Час не вигадується: "десь о 1:00 годині дня" -> 13:00 явно сказано; без часу - гілка перепитування.
- Відповіді без `parse_mode`.

## Acceptance criteria (чернетка; фіксується на READY)

- **repro-fixed:** відтворення вище -> `/export` від U4 містить reminder з `eventAt`
  `2026-10-26T13:00:00+02:00` (Kyiv перейшов на зимовий час 25 жовтня 2026), і **не** містить нового
  запису в `notes` з цим текстом. 3 з 3 прогонів.
- **note-unchanged:** `"Цікава думка: годинник краще заряджати вночі."` від U4 -> новий запис у
  `notes`, reminder не створено.
- **no-regression:** `npm test` зелений.

## Out of scope

- Розділення одного повідомлення на нагадування **і** нотатку.
- Повторне створення видаленого нагадування власника (дата вже минула).
