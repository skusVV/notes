---
id: 0022-morning-run
state: DONE
attempt: 0
max_attempts: 3
branch: feat/0022-morning-run
delivery: manual
acceptance: []
failures: []
---

# 0022 - Ранкова джоба: синк Garmin з ретраями, потім звіт

> **DONE 2026-11-24.** Код - `a5b7c3a`. GCP налаштовано через `gcloud` з дозволу власника:
> тригер `morning-run` (`morning-run/**` на `^main$`), Cloud Run job `morning-run` (Node 24, timeout
> 1800 с, без автоповторів), змінні `GARMIN_OWNER_USER_ID` і `BOT_BASE_URL` на джобі, Scheduler
> `morning-run` `0 7 * * *` Europe/Kyiv (OAuth, compute SA). Доступи не знадобились: compute SA уже мав
> їх на рівні проєкту.
>
> **Перевірено наживо (виконання `morning-run-dz4km`, 2026-11-24 10:00 UTC):** `stops-early-on-success`
> (1 спроба, `outcome: success`, `sleepToday: true`, 0 алертів), виклик бота `200` (`reason: empty` -
> нагадувань на сьогодні немає, розділів Garmin ще немає, тож звіт порожній і не шлеться, як задумано),
> `no-secret-in-logs`, `garminSync.lastSuccessAt` оновився. **Не перевірено наживо, лише юніт-тестами
> або локально:** `retries-on-missing-sleep`, `auth-rejected-no-retry`, `garmin-down-digest-still-sent`,
> `bot-errors-do-not-crash` (локально, фейковий бот), `digest-call-ok` з `sent: true` і `already_sent`
> (потрібен непорожній звіт), `timing` (перший справжній запуск - завтра о 07:00).
