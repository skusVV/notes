---
id: 0009-interval-reminders
state: READY
attempt: 0
max_attempts: 3
branch: feat/0009-interval-reminders
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: auth-401
    assert: "POST any update with a wrong X-Telegram-Bot-Api-Secret-Token returns HTTP 401"
  - id: interval-captured
    assert: "With X-Test-Now=2026-09-21T10:00:00+03:00, POST 'Здавати аналізи Apo-B та ліпідограму раз на 4 місяці' from user id U60; a '/export' from U60 shows exactly one reminder whose originalText equals that message, and that reminder has recurrence.kind == 'interval', recurrence.every == {count: 4, unit: 'month'}, recurrence.atLocal == '09:00', lastCompletedAt null/absent, expireAt null/absent, and exactly one notification - status 'scheduled', role 'cycle', leadDays 0, at == '2027-01-21T09:00:00+02:00' (created + 4 months, at the 09:00 default, winter offset)"
  - id: lead-days-scheduled
    assert: "With X-Test-Now=2026-09-21T10:00:00+03:00, POST 'Здавати аналізи раз на 4 місяці, нагадай за 1 тиждень і за 3 дні' from user id U61; a '/export' from U61 shows exactly one reminder whose originalText equals that message, with recurrence.kind == 'interval', and that reminder has exactly three notifications, all status 'scheduled', role 'cycle' and occurrenceAt == '2027-01-21T09:00:00+02:00': leadDays 7 at '2027-01-14T09:00:00+02:00', leadDays 3 at '2027-01-18T09:00:00+02:00', leadDays 0 at '2027-01-21T09:00:00+02:00'"
  - id: completion-restarts-cycle
    assert: "Continuing from lead-days-scheduled on that same U61 reminder: POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2027-01-21T08:50:00+02:00, and the reflected replies contain exactly one delivery; then POST a callback_query update from U61 with data 'done:rem:<that reminder id>' and X-Test-Now=2027-01-21T12:00:00+02:00; a following '/export' from U61 shows that reminder with lastCompletedAt == '2027-01-21T12:00:00+02:00', no notification with occurrenceAt == '2027-01-21T09:00:00+02:00' still in status 'scheduled', and exactly three notifications in status 'scheduled', all with occurrenceAt == '2027-05-21T09:00:00+03:00', at '2027-05-14T09:00:00+03:00', '2027-05-18T09:00:00+03:00' and '2027-05-21T09:00:00+03:00' (four months from the completion DATE, at atLocal, summer offset)"
  - id: late-completion-shifts-cycle
    assert: "With X-Test-Now=2026-09-21T10:00:00+03:00, POST 'Здавати кров раз на 4 місяці' from user id U62; POST /sweep with X-Test-Now=2027-01-21T08:50:00+02:00; then POST a callback_query from U62 with data 'done:rem:<that reminder id>' and X-Test-Now=2027-02-01T12:00:00+02:00 (eleven days late); a '/export' from U62 shows that reminder with exactly one notification in status 'scheduled', at '2027-06-01T09:00:00+03:00' - measured from the completion, NOT the '2027-05-21T09:00:00+03:00' that measuring from the calendar would give"
  - id: followup-when-ignored
    assert: "With X-Test-Now=2026-09-21T10:00:00+03:00, POST 'Робити флюорографію раз на 12 місяців' from user id U63; POST /sweep with X-Test-Now=2027-09-21T08:50:00+03:00 and tap no button; a '/export' from U63 then shows that reminder with exactly one notification in status 'scheduled', role 'follow_up', at '2027-09-23T09:00:00+03:00'; a second POST /sweep with X-Test-Now=2027-09-23T08:50:00+03:00 yields exactly one further delivery for that reminder"
  - id: notyet-and-planned
    assert: "Continuing from followup-when-ignored: read that reminder's delivered follow_up notification id from a '/export', POST a callback_query from U63 with data 'rem:notyet:<that notification id>' and X-Test-Now=2027-09-23T12:00:00+03:00; a '/export' shows that reminder with exactly one notification in status 'scheduled', role 'follow_up', at '2027-09-25T09:00:00+03:00'. Then POST a callback_query from U63 with data 'rem:plan:<that new notification id>' and X-Test-Now=2027-09-25T12:00:00+03:00; a '/export' shows exactly one notification in status 'scheduled', role 'follow_up', at '2027-10-02T09:00:00+03:00'"
  - id: calendar-recurrence-unchanged
    assert: "With X-Test-Now=2026-09-21T10:00:00+03:00, POST 'Bob has a birthday on June 12' from user id U64; a '/export' from U64 shows exactly one reminder whose originalText equals that message, with recurrence.kind == 'calendar', freq 'yearly', month 6, day 12, expireAt null/absent, and exactly one notification - status 'scheduled', role 'cycle', leadDays 0, at '2027-06-12T09:00:00+03:00'; POST /sweep with X-Test-Now=2027-06-12T08:50:00+03:00 and a following '/export' shows that reminder with a NEW notification in status 'scheduled' at '2028-06-12T09:00:00+03:00', with no completion tap involved"
  - id: unsupported-repeat-explained
    assert: "With X-Test-Now=2026-09-21T10:00:00+03:00, POST 'Нагадуй мені кожен другий вівторок місяця перевіряти пошту' from user id U65; a '/export' from U65 shows no reminder whose originalText equals that message; the reflected replies for that POST contain a line exactly equal to 'Зрозумів як нагадування, але не вмію такий повтор. Я вмію: щодня, щотижня, щомісяця, щороку і «раз на N днів/тижнів/місяців/років».' and contain neither the substring 'not confident' nor the substring '(0.4'"
  - id: text-completion-lists-and-completes
    assert: "Continuing from interval-captured on that same U60 reminder: POST 'здав ліпідограму сьогодні' from U60 with X-Test-Now=2026-10-05T12:00:00+03:00; a '/export' from U60 shows that reminder still with lastCompletedAt null/absent (nothing applied without a tap) and the reflected replies contain a line exactly equal to 'Що саме ти виконав? Обери зі списку.'; then POST a callback_query from U60 with data 'done:rem:<that reminder id>' and X-Test-Now=2026-10-05T12:00:00+03:00; a '/export' shows that reminder with lastCompletedAt == '2026-10-05T12:00:00+03:00' and exactly one notification in status 'scheduled', at '2027-02-05T09:00:00+02:00'"
failures: []
---

# 0009 - Interval reminders measured from completion

## Context

Три повідомлення поспіль про «здавати аналізи Apo-B та ліпідограму раз на 4 місяці» не зберіглися,
і бот щоразу відповідав `I am not confident this is reminder (0.49)`. Та відповідь неправдива на двох
рівнях. По-перше, модель була впевнена - `0.49` це рівно `CONFIDENCE_ASK - 0.01`, яке підставляє код у
[classifier.service.ts:554-557](../../src/classifier/classifier.service.ts#L554-L557), коли payload
нагадування непридатний. По-друге, справжня причина - `раз на 4 місяці` не існує в наборі повторень:
[recurrence.ts:8](../../src/reminders/recurrence.ts#L8) знає лише `daily|weekly|monthly|yearly` без
інтервалу, тож [normalizeRecurrence](../../src/reminders/recurrence.ts#L79) чесно повертає `undefined`,
і нагадування падає у гілку «перепитати». Переформулювання допомогти не могло ніколи.

Обидва обмеження свідомі: [0005](0005-recurring-reminders.md) прямо виніс складні правила і lead-time
для повторюваних у **Out of scope**. Цей спек знімає саме їх - і робить це не розширенням `freq`, а
введенням **другого типу повторення**, бо два випадки принципово різні:

- **Календарний** (`calendar`) - день народження, 25 грудня, щопонеділка. Прив'язаний до сітки
  календаря і не зсувається ніколи, скільки б користувач не спізнився. Це те, що вже працює.
- **Інтервальний** (`interval`) - аналізи раз на 4 місяці. Наступний цикл рахується **від дня, коли
  справу справді виконано**, а не від запланованої дати. Якщо рахувати від календаря, а користувач
  здав на тиждень пізніше, інтервал стискається - за рік набігає перекіс на місяць, і нагадування
  починає приходити тоді, коли минуло не 4 місяці, а 3.

Інтервальний тип вимагає сигналу «виконано», якого в боті немає: кнопка `OK`
([0005](0005-recurring-reminders.md#L84-L86)) означає лише «побачив». Тому спек додає кнопку
**Виконав**, статусні відповіді **Ще ні** / **Заплановано**, автоматичне перепитування, поки статус не
названо, і текстовий шлях «здав аналізи» - який **ніколи не вгадує**, що саме виконано, а завжди
показує список і чекає на дотик.

**Залежить від [0008](0008-human-readable-times.md), змердженого в `main`** - він володіє
`humanizeInstant`/`humanizeTimeOfDay` і українськими рядками відповідей, які цей спек продовжує.
Також залежить від 0002-0005.

## Scope

- `src/reminders/recurrence.ts` - `kind`, `every`, розв'язання інтервальних оказій,
  `describeRecurrence` для інтервалу. Календарна гілка не змінюється поведінково.
- `src/reminders/notify-times.ts` - параметризований запис `days_before:<n>`.
- `src/reminders/follow-up.ts` - **новий.** Драбина перепитувань, чиста функція без Nest і годинника.
- `src/reminders/reminders.service.ts` - `notifySpec`, `role`/`leadDays`/`occurrenceAt` на
  сповіщеннях, `completeInterval`, `armCycle`, `armFollowUp`, нові поля `/export`.
- `src/classifier/classifier.service.ts` + `classifier.types.ts` - `kind`/`every`, `days_before:<n>`,
  `lastDoneAt`, інтент `completion`, поле `blocked`.
- `src/telegram/telegram.service.ts` - клавіатура інтервальної доставки, нові дії callback, список
  для текстового «виконав», правдиві відповіді для `blocked`.
- `src/telegram/sweeper.service.ts` - озброєння перепитування після доставки; roll-forward лише для
  `calendar`.
- `test/` - нові `follow-up.spec.ts`, `interval-recurrence.spec.ts`; оновлені `recurrence.spec.ts`,
  `notify-times.spec.ts`, `reminders.service.spec.ts`, `sweeper.service.spec.ts`,
  `telegram.callback.spec.ts`, `telegram.service.spec.ts`, `classifier.reminder.spec.ts`.
- `CLAUDE.md` - один абзац в **Architecture**, текст у **Contracts**.

Поза межами без повернення в `DRAFT`: актори, транскрипція, контракт вебхука, схема аутентифікації,
`docs/architecture.md` (це ручний планувальний документ).

## Contracts

### Повторення: два види (`src/reminders/recurrence.ts`)

```ts
export type RecurrenceKind = 'calendar' | 'interval';
export const INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export interface Recurrence {
  kind: RecurrenceKind;
  /** `calendar` only. */
  freq?: RecurrenceFreq;
  month?: number;
  day?: number;
  weekday?: Weekday;
  /** `interval` only. `{count: 4, unit: 'month'}` = раз на 4 місяці. */
  every?: { count: number; unit: IntervalUnit };
  atLocal: string;
  timezone: string;
}
```

Правила, всі нормативні:

1. **`normalizeRecurrence` - єдиний суддя.** Вона й далі нічого не ремонтує: `interval` без
   `every`, `count < 1`, `count > 365`, невідомий `unit`, `calendar` без `freq` - усе повертає
   `undefined`. Вигадане правило спрацьовує вічно у час, якого користувач не називав.
2. **Зворотна сумісність.** Збережений документ без `kind` читається як `kind: 'calendar'`. Жодної
   міграції: [0005](0005-recurring-reminders.md) писав саме таку форму, і вона лишається валідною.
3. **`nextOccurrence`/`nextOccurrenceAfter` не застосовні до `interval`** і повертають `undefined`
   для нього. Інтервальна оказія не обчислюється з сітки календаря - вона обчислюється з якоря:

```ts
/**
 * Оказія інтервального правила: `anchor` + `every`, у час `atLocal` того дня.
 * `undefined`, якщо правило не інтервальне або зона не розв'язується.
 */
export function occurrenceAfterAnchor(
  recurrence: Recurrence,
  anchor: Date,
  now: Date,
): string | undefined;
```

4. **Якір - це дата, не час.** Від `anchor` береться лише календарний день у зоні правила; час доби
   завжди `atLocal`. Тому «Виконав» о 12:00 дає наступну оказію о 09:00, а не о 12:00.
5. **Додавання місяців затискається** (luxon `plus({months})`): виконано 31 січня + 4 місяці = 31
   травня; виконано 31 жовтня + 4 місяці = 28/29 лютого. Затиснення, а не пропуск місяця - той самий
   вибір, що вже зроблено в [onDayOfMonth](../../src/reminders/recurrence.ts#L221).
6. **Оказія в минулому підтягується вперед.** Якщо `anchor + every` не пізніше за `now` (користувач
   сказав, що виконував давно), результат - найближчий `atLocal` строго після `now`: сьогодні, якщо
   `atLocal` ще не минув, інакше завтра. Це не вигаданий час - `atLocal` уже належить правилу.
7. **`describeRecurrence` для інтервалу**, українською, поверх `humanizeTimeOfDay` з
   [0008](0008-human-readable-times.md): `раз на 4 місяці о 9:00`. `count == 1` йде без числа:
   `раз на місяць о 9:00`. Форми числівника за стандартним правилом - `n % 10 == 1 && n % 100 != 11`
   -> `день / тиждень / місяць / рік`; `n % 10` у 2..4 і `n % 100` не в 12..14 -> `дні / тижні /
   місяці / роки`; інакше -> `днів / тижнів / місяців / років`.

### Попередження за N днів (`src/reminders/notify-times.ts`)

`RELATIVE_NOTIFY` лишається закритим набором з п'яти слів і додає **один параметризований запис**:

```
days_before:<n>     // n ціле, 1..365
```

Розв'язується як `eventAt` мінус `n` днів **у той самий час доби, що й `eventAt`**. Нової години не
вигадується - це головна причина, чому запис саме такий, а не «за тиждень зранку».

`resolveNotifyTimes` не змінює свого контракту: нерозв'язний запис відкидається, запис у минулому
відкидається, і якщо не лишається нічого - одне сповіщення в момент події. Це одразу лагодить
«нагадай за 3 дні» і для звичайних одноразових нагадувань, які досі мовчки його ігнорували.

### Модель даних сповіщень

Кожен документ сповіщення отримує три поля, які й виходять у `/export`:

| поле | значення |
|---|---|
| `role` | `'cycle'` - належить оказії повторення; `'follow_up'` - перепитування; `'one_off'` - звичайне нагадування 0002/0004 |
| `leadDays` | `0` для самої оказії, `7`/`3` для попереджень; `null` для `follow_up` і `one_off` |
| `occurrenceAt` | локальний ISO оказії, до якої сповіщення належить; `null` для `one_off` |

Збережене сповіщення без `role` читається як `'one_off'`, а там, де потрібен `occurrenceAt`, його
відсутність підмінюється власним `atLocal` документа - так наявні дні народження з
[0005](0005-recurring-reminders.md) продовжують котитися без міграції.

Документ нагадування отримує:

| поле | значення |
|---|---|
| `notifySpec` | `string[]` - запити на попередження, як їх повернув класифікатор (`["days_before:7","days_before:3"]`). Потрібен, щоб кожен новий цикл відтворював ті самі попередження |
| `lastCompletedAt` | локальний ISO моменту останнього «Виконав», або відсутнє |
| `followUpCount` | лічильник перепитувань поточного циклу; скидається в 0 на початку кожного циклу |

`expireAt` відсутній для обох видів повторення - інтервальне нагадування так само не має права
загинути від TTL, з тієї ж причини, що й день народження.

### Цикл (`armCycle`)

```ts
/** Озброює всі сповіщення однієї оказії. Повертає їх локальні часи, зростаюче. */
private armCycle(reminderRef, recurrence, occurrenceAt, notifySpec, now): Promise<string[]>
```

Набір = сама оказія (`leadDays: 0`) плюс по одному попередженню на кожен `days_before:<n>` у
`notifySpec`, у той самий `atLocal`, **лише якщо воно строго пізніше за `now`**. Попередження, яке вже
минуло (правило створено за 3 дні до першої оказії), просто не створюється - це не помилка.
`followUpCount` нагадування скидається в `0`.

### Перехід між циклами

| вид | що рухає цикл уперед | коли |
|---|---|---|
| `calendar` | доставка сповіщення з `leadDays == 0` | у свіпі, як у 0005 |
| `interval` | **«Виконав»** | у callback, ніколи у свіпі |

Ідемпотентність roll-forward більше **не** може спиратися на «немає жодного запланованого
сповіщення» ([reminders.service.ts:284-330](../../src/reminders/reminders.service.ts#L284-L330)): під
час циклу з попередженнями інші сповіщення тієї ж оказії ще заплановані. Замість цього транзакція
відмовляється писати, якщо в нагадуванні вже існує сповіщення з `occurrenceAt`, рівним обчисленому.

### Перепитування (`src/reminders/follow-up.ts`)

```ts
/** Проміжки між перепитуваннями, у днях. Останнє значення повторюється далі. */
export const FOLLOW_UP_LADDER_DAYS = [2, 2, 4, 7, 14] as const;
/** Скільки днів до наступного перепитування після `count` попередніх. */
export function followUpDays(count: number): number;
/** Кнопка «Ще ні». */ export const NOT_YET_DAYS = 2;
/** Кнопка «Заплановано». */ export const PLANNED_DAYS = 7;
```

Коли свіп доставив сповіщення інтервального нагадування з `leadDays == 0` **або** перепитування, він
одразу озброює наступне перепитування на `followUpDays(followUpCount)` днів уперед, у `atLocal` того
дня, і збільшує `followUpCount`. Попередження (`leadDays > 0`) перепитувань не породжують.

Драбина не має стелі й ніколи не зупиняється: проміжок росте 2, 2, 4, 7, 14, 14, 14... днів. Обірвати
ланцюг мовчки не можна - саме мовчазний обрив і є та поломка, від якої цей спек захищає; а зростаючий
проміжок не дає забутому нагадуванню перетворитися на шум.

### Кнопки і `callback_data`

Доставка **інтервального** нагадування (і оказії, і перепитування) несе три кнопки:

| кнопка | `callback_data` | дія |
|---|---|---|
| `Виконав` | `done:rem:<reminderId>` | завершує цикл, рахує наступний від `now` |
| `Ще ні` | `rem:notyet:<notificationId>` | пересуває перепитування на `NOT_YET_DAYS` днів |
| `Заплановано` | `rem:plan:<notificationId>` | пересуває перепитування на `PLANNED_DAYS` днів |

Доставка одноразового і **календарного** нагадування несе ту саму клавіатуру, що й раніше -
`Готово` / `+1 год` / `Завтра` з незмінними `rem:ok|1h|tmrw:<notificationId>`
([telegram.service.ts:111-120](../../src/telegram/telegram.service.ts#L111-L120)). Жодне вже
доставлене повідомлення не ламається.

`done:rem:<reminderId>` - **єдиний** шлях завершення, спільний для кнопки на доставці і для дотику в
списку з текстового шляху. Префікс `done` відрізняє його від `rem`, третє поле - id нагадування, а не
сповіщення; `parseCallbackData` лишається як є, поруч з'являється `parseCompletionData`. Перевірка
власника робиться шляхом `users/{userId}/reminders/{reminderId}`, тобто чужий id просто не існує -
той самий прийом, що вже використано в
[getOwnedNotification](../../src/reminders/reminders.service.ts#L440-L470).

`completeInterval(userId, reminderId, now)` в одній транзакції: ставить `lastCompletedAt = now`,
переводить `sent`-сповіщення поточної оказії в `acked`, а `scheduled` - у `cancelled` (не видаляє:
історія циклів і є те, заради чого все будувалося), потім озброює наступний цикл через `armCycle` з
оказією `occurrenceAfterAnchor(recurrence, now, now)`. Відповідь називає наступну дату через
`humanizeInstant`.

### Текстове «виконав»

Новий інтент `completion` у [INTENTS](../../src/classifier/classifier.types.ts#L6), payload
`{ what: string }` - слова користувача. Бот **ніколи не вирішує сам**, що саме виконано: він показує
всі інтервальні нагадування користувача як кнопки `done:rem:<reminderId>` (до 10, за спаданням
`eventAt`) під рядком, точно рівним:

```
Що саме ти виконав? Обери зі списку.
```

Один кандидат - той самий рядок і одна кнопка; жодного автозастосування. Нуль кандидатів - рядок
`У тебе немає нагадувань, які повторюються від виконання.`. `what` не бере участі у виборі: зіставляти
слова з назвами - це рівно та помилка, якої тут не має статися, і кнопка коштує один дотик.

Текстове завершення працює й тоді, коли жодне сповіщення ще не приходило: здати аналізи на тиждень
раніше - нормально, і цикл має поїхати від цієї дати.

### Правдива відмова замість вигаданої невпевненості

`Classification` отримує `blocked?: BlockedReason`, де
`type BlockedReason = 'no_time' | 'unsupported_repeat'`. Його виставляє той самий блок, що вже
занижує впевненість ([classifier.service.ts:547-557](../../src/classifier/classifier.service.ts#L547-L557)):
`unsupported_repeat`, коли модель повернула об'єкт повторення, а `normalizeRecurrence` його відхилила;
`no_time`, коли нагадування без повторення не має розв'язного часу. Заниження впевненості лишається -
воно й далі не дає зберегти непридатне - але **гілка відповіді тепер дивиться на `blocked` перед
смугою впевненості**, і друкує точний рядок:

| `blocked` | рядок відповіді |
|---|---|
| `no_time` | `Зрозумів як нагадування, але не зрозумів коли. Напиши дату і час.` |
| `unsupported_repeat` | `Зрозумів як нагадування, але не вмію такий повтор. Я вмію: щодня, щотижня, щомісяця, щороку і «раз на N днів/тижнів/місяців/років».` |

`describeUnsure` ([telegram.service.ts:803-806](../../src/telegram/telegram.service.ts#L803-L806))
лишається лише для випадків **без** `blocked` - тобто там, де модель справді вагалася.

### Класифікатор: як розрізняти два види повторення

Правило в системній інструкції, нормативне і коротке:

- Повторення, прив'язане до **фіксованої дати або дня тижня** - день народження, `25 грудня`,
  `щопонеділка`, `1 числа кожного місяця` - це `kind: 'calendar'`.
- Повторення, виражене **лише періодом** - `раз на 4 місяці`, `кожні 2 тижні`, `every 6 weeks` - це
  `kind: 'interval'`, бо календарного якоря в ньому немає.
- `щодня`, `щотижня`, `щомісяця`, `щороку` без дати лишаються `calendar` з відповідним `freq`: вони
  вже працюють, і перетворювати їх на інтервал було б регресією.
- `lastDoneAt` (ISO дата, необов'язкове) - заповнюється **тільки** якщо повідомлення називає, коли
  справу виконано востаннє (`здавав у липні`). Відсутнє - якорем стає момент створення.

Схема відповіді, `temperature: 0` і правило «відсутнє лишається відсутнім» не змінюються.

### `CLAUDE.md` - абзац після *"Replies are chunked"*

> **Повторення буває двох видів, і плутати їх не можна.** `calendar` прив'язане до сітки календаря
> (день народження, щопонеділка) і котиться вперед у свіпі після доставки. `interval` (`раз на 4
> місяці`) котиться **тільки** після кнопки «Виконав», від дати виконання - інакше кожне запізнення
> стискає інтервал назавжди. Тому інтервальне нагадування, на яке не відповіли, перепитує себе за
> драбиною [follow-up.ts](src/reminders/follow-up.ts), а не зникає. Сигнал «виконано» ніколи не
> виводиться з тексту моделлю: бот показує список і чекає на дотик.

## Invariants (must not break)

- Усе, що зафіксували 0003 і 0004: транзакційний `scheduled -> sent`, перевірка власника, гейт
  `ALLOWED_USERS` перед будь-яким читанням і записом, відсутність `parse_mode`, логи без вмісту.
- Вебхук відповідає `200` завжди, крім неправильного секрет-токена (`401`).
- **Повторення ніколи не вигадується.** Ні `kind`, ні `every`, ні `days_before` не з'являються з
  розпливчастого слова; невалідне правило відкидається, а не ремонтується.
- **Жодне повторюване нагадування не має `expireAt`** - ні календарне, ні інтервальне, ні їхні
  сповіщення, включно з перепитуваннями і після snooze.
- **Інтервальне нагадування не рухається саме по собі.** Свіп ніколи не переносить його цикл; лише
  `completeInterval` це робить. Свіп має право додати перепитування і нічого більше.
- **Ланцюг не рветься мовчки.** Після доставки оказії інтервального нагадування завжди існує рівно
  одне заплановане перепитування, доки цикл не завершено.
- **Не більше однієї оказії наперед.** У нагадування ніколи не існує запланованих сповіщень для двох
  різних `occurrenceAt`.
- Жодного сирого timestamp у чаті - усе через `humanizeInstant`/`humanizeTimeOfDay`
  ([0008](0008-human-readable-times.md)).
- Health-data discipline: ні транскрипти, ні назви нагадувань не потрапляють у логи.

## Acceptance criteria (locked at READY)

Дзеркалять frontmatter. Часовий пояс усюди `Europe/Kyiv`; зимові оказії несуть `+02:00`, літні
`+03:00` - і це не косметика, а доказ, що час зберігається як настінний, а не як миттєвість.

- **health:** `GET /` -> `200`, `{"status":"ok"}`.
- **auth-401:** неправильний секрет-токен -> `401`.
- **interval-captured:** `раз на 4 місяці` зберігається як `kind: 'interval'`, `every {4, month}`,
  перша оказія `2027-01-21T09:00:00+02:00`, без `expireAt`.
- **lead-days-scheduled:** `за 1 тиждень і за 3 дні` дають рівно три `cycle`-сповіщення однієї
  оказії з `leadDays` 7, 3, 0.
- **completion-restarts-cycle:** після «Виконав» о 12:00 попередній цикл більше не запланований, а
  новий стоїть на `2027-05-21T09:00:00+03:00` з тими самими двома попередженнями - тобто час доби
  береться з `atLocal`, а не з моменту дотику.
- **late-completion-shifts-cycle:** «Виконав» на 11 днів пізніше дає `2027-06-01`, а не `2027-05-21`.
  Це критерій, заради якого існує весь спек.
- **followup-when-ignored:** доставка без жодного дотику лишає одне заплановане перепитування через
  2 дні, і наступний свіп його доставляє.
- **notyet-and-planned:** `Ще ні` -> +2 дні, `Заплановано` -> +7 днів, щоразу рівно одне заплановане
  перепитування.
- **calendar-recurrence-unchanged:** день народження з 0005 поводиться точно як раніше і котиться у
  свіпі без жодного «Виконав».
- **unsupported-repeat-explained:** `кожен другий вівторок` нічого не зберігає і відповідає точним
  рядком про непідтримуваний повтор - без `not confident` і без `(0.4`.

Кожен критерій знаходить своє нагадування за `originalText` і рахує сповіщення **в межах цього
нагадування**, а не в усьому `/export`. Тестова функція ділить сховище між прогонами, а повторювані
нагадування навмисно не мають `expireAt` і не зникають самі - тож будь-яке `reminders == []` або
«рівно одне нагадування в експорті» зламалося б об залишки попередніх верифікацій.
- **text-completion-lists-and-completes:** `здав ліпідограму` нічого не застосовує сам, показує
  список, і лише дотик завершує цикл.

Модульні тести (детерміністичні): `followUpDays` по всій драбині і за її межею;
`occurrenceAfterAnchor` для кожної одиниці, через межу DST, із затисненням дня місяця і з якорем у
минулому; `days_before:<n>` у `resolveNotifyTimes` включно з попередженням у минулому;
`normalizeRecurrence` для обох видів, для документа без `kind` і для кожної форми невалідного
`every`; ідемпотентність `armCycle` за `occurrenceAt`; українські форми числівника в
`describeRecurrence`.

## Out of scope

- **Скасування або редагування** нагадування - ні «стоп», ні «пропустити цей раз». Успадковано з
  [0005](0005-recurring-reminders.md) без змін.
- **Складні календарні правила** - «кожен другий вівторок», «останній день місяця», «по буднях».
  Цей спек додає інтервал, а не довільний RRULE; такий запит тепер чесно відмовляє.
- **Попередження, задані в годинах або тижнях окремою одиницею.** Усе зводиться до днів; `за 1
  тиждень` -> `days_before:7`.
- **Зіставлення тексту з конкретним нагадуванням.** `completion` завжди питає кнопкою. Автовибір -
  окремий спек, і лише якщо список почне заважати.
- **Нотатки і симптоми** - `blocked` додається лише для нагадувань; решта інтентів лишається на
  поточній поведінці.
- **Міграція наявних даних.** Відсутній `kind` читається як `calendar`, відсутній `role` - як
  `one_off`; жодного backfill.
