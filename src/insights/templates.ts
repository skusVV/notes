import { formatDuration, formatNumber, formatSteps } from '../garmin/garmin-format';
import { humanizeTimeOfDay } from '../reminders/humanize-time';

/**
 * The template text of every insight line (spec 0026, decision 8) and the `numbers` each must keep.
 * Pure: values in, `{ template, numbers }` out. Every number a line shows is in `numbers`, so a
 * rewritten line that drops or changes one falls back to this text.
 *
 * Wording rules: one sentence, "ти", no diagnosis, no cause that is not in the data - a coincidence
 * is called a coincidence, a signal a signal (0021).
 */

export interface TemplateText {
  template: string;
  numbers: string[];
}

/** Ukrainian plural: `plural(1, ['день', 'дні', 'днів'])` is `день`; 2-4 `дні`; 5-20 `днів`. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(Math.round(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return forms[1];
  }
  return forms[2];
}

const DAYS: readonly [string, string, string] = ['день', 'дні', 'днів'];

/** `+12%` / `-8%` - a signed relative change. */
export function formatChange(share: number): string {
  const percent = Math.round(share * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/** `12%` from a 0..1 share. */
export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * `H:mm` of minutes since midnight (wrapped into 0..1439) - the form `humanizeTimeOfDay` prints
 * (`о 0:20`), so the number a line must keep is exactly what it shows.
 */
export function clockText(minutesOfDay: number): string {
  const wrapped = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** Minutes as `45 хв` / `1 год 5 хв`. */
export function minutesText(minutes: number): string {
  return formatDuration(Math.round(minutes) * 60);
}

/** A readiness signal that came out bad, as shown in the line. */
export interface BadSignal {
  text: string;
  number: string;
}

export const READINESS_MARKERS = { green: '🟢', yellow: '🟡', red: '🔴' } as const;

export function readinessText(
  level: 'green' | 'yellow' | 'red',
  bad: readonly BadSignal[],
  rhrWarning: boolean,
): TemplateText {
  const marker = READINESS_MARKERS[level];
  if (level === 'green') {
    return { template: `${marker} Готовність: добра, сигнали відновлення в нормі.`, numbers: [] };
  }
  const reasons = bad.map((signal) => signal.text);
  if (rhrWarning && reasons.length === 0) {
    reasons.push('пульс спокою кілька днів вищий за звичний');
  }
  const word = level === 'red' ? 'низька' : 'середня';
  return {
    template: `${marker} Готовність: ${word}, бо ${reasons.join(', ')}.`,
    numbers: bad.map((signal) => signal.number),
  };
}

export const readinessSignals = {
  hrv: (hrv: number): BadSignal => ({
    text: `HRV ${formatNumber(hrv)} мс нижче базової лінії`,
    number: formatNumber(hrv),
  }),
  rhr: (rhr: number): BadSignal => ({
    text: `пульс спокою ${formatNumber(rhr)} вищий за звичний`,
    number: formatNumber(rhr),
  }),
  sleep: (sleepSeconds: number): BadSignal => ({
    text: `сон ${formatDuration(sleepSeconds)} менший за потребу`,
    number: formatDuration(sleepSeconds),
  }),
  battery: (battery: number): BadSignal => ({
    text: `батарея після сну лише ${formatNumber(battery)}`,
    number: formatNumber(battery),
  }),
};

export function rhrWarningText(diff: number, days: number, companions: readonly string[]): TemplateText {
  const delta = `+${formatNumber(diff)}`;
  const together = companions.length > 0 ? `, а ще ${companions.join(' і ')}` : '';
  return {
    template:
      `Пульс спокою ${days} ${plural(days, DAYS)} поспіль ${delta} уд/хв до звичного${together}: ` +
      'це сигнал навантаження, так буває перед застудою або від перевтоми, не діагноз.',
    numbers: [delta, String(days)],
  };
}

export const RHR_COMPANIONS = {
  respiration: 'дихання уві сні частіше за звичне',
  hrv: 'HRV нижче базової лінії',
};

export function loadHardText(load: number, median: number, hrv: number | null, rhr: number | null): TemplateText {
  const loadText = formatNumber(load);
  const medianText = formatNumber(median);
  const numbers = [loadText, medianText];
  let recovery: string;
  if (hrv !== null) {
    recovery = `HRV ${formatNumber(hrv)} мс нижче базової лінії`;
    numbers.push(formatNumber(hrv));
  } else {
    recovery = `пульс спокою ${formatNumber(rhr ?? 0)} вищий за звичний`;
    numbers.push(formatNumber(rhr ?? 0));
  }
  return {
    template: `Вчора навантаження ${loadText} проти звичних ${medianText}, а сьогодні ${recovery}: краще легкий день.`,
    numbers,
  };
}

export function loadGoodText(hrv: number): TemplateText {
  return {
    template: `HRV ${formatNumber(hrv)} мс вище твого діапазону і всі сигнали в нормі: добрий день для інтенсиву.`,
    numbers: [formatNumber(hrv)],
  };
}

export function sleepDebtText(debtMinutes: number, nights: number): TemplateText {
  const debt = minutesText(debtMinutes);
  return {
    template: `За ${nights} ${plural(nights, ['ніч', 'ночі', 'ночей'])} набігло ${debt} недосипу від твоєї потреби сну.`,
    numbers: [debt],
  };
}

export type DepthMetric = 'deep' | 'rem' | 'awake';

const DEPTH_LABELS: Record<DepthMetric, string> = {
  deep: 'Глибокого сну',
  rem: 'REM-сну',
  awake: 'Пробуджень',
};

export const DEPTH_CAUSES = {
  stress: 'високим стресом учора',
  lateWorkout: 'пізнім тренуванням',
  load: 'великим навантаженням учора',
  lateSleep: 'пізнім засинанням',
};

export function sleepDepthText(
  metric: DepthMetric,
  value: number,
  norm: number,
  causes: readonly string[],
): TemplateText {
  const unit = metric === 'awake' ? '' : ' хв';
  const valueText = formatNumber(value);
  const normText = formatNumber(norm);
  const coincidence =
    causes.length > 0 ? `; збіглося з ${causes.join(' і ')}, це збіг, а не обов'язково причина` : '';
  return {
    template: `${DEPTH_LABELS[metric]} ${valueText}${unit} проти звичних ${normText}${unit}${coincidence}.`,
    numbers: [valueText, normText],
  };
}

export function stressBatteryText(
  stress: { share: number; norm: number } | null,
  battery: { value: number; norm: number } | null,
): TemplateText {
  const numbers: string[] = [];
  const parts: string[] = [];
  if (stress) {
    const share = formatShare(stress.share);
    const norm = formatShare(stress.norm);
    numbers.push(share, norm);
    parts.push(`вчора високого стресу було ${share} дня проти звичних ${norm}`);
  }
  if (battery) {
    const value = formatNumber(battery.value);
    const norm = formatNumber(battery.norm);
    numbers.push(value, norm);
    parts.push(
      stress
        ? `тож і батарея після сну лише ${value} проти звичних ${norm}`
        : `батарея після сну лише ${value} проти звичних ${norm}`,
    );
  }
  const text = parts.join(', ');
  return { template: `${text.charAt(0).toUpperCase()}${text.slice(1)}.`, numbers };
}

export function rhythmGoodText(earliest: number, latest: number): TemplateText {
  const a = clockText(earliest);
  const b = clockText(latest);
  return {
    template: `Ритм сну стабільний: цей тиждень засинаєш найраніше ${humanizeTimeOfDay(a)}, найпізніше ${humanizeTimeOfDay(b)}.`,
    numbers: [a, b],
  };
}

export function rhythmSpreadText(earliest: number, latest: number): TemplateText {
  const a = clockText(earliest);
  const b = clockText(latest);
  return {
    template: `Час засинання цього тижня гуляє: найраніше ${humanizeTimeOfDay(a)}, найпізніше ${humanizeTimeOfDay(b)}.`,
    numbers: [a, b],
  };
}

export function rhythmWeekendText(shiftMinutes: number): TemplateText {
  const shift = minutesText(Math.abs(shiftMinutes));
  const direction = shiftMinutes > 0 ? 'пізніше' : 'раніше';
  return {
    template: `На вихідних засинаєш на ${shift} ${direction}, ніж у будні.`,
    numbers: [shift],
  };
}

export function caloriesText(metric: 'total' | 'active', average: number, previous: number, change: number): TemplateText {
  const label = metric === 'active' ? 'Активних калорій' : 'Калорій';
  const a = formatSteps(average);
  const b = formatSteps(previous);
  const pct = formatChange(change);
  return {
    template: `${label} за тиждень у середньому ${a} на день проти ${b} тижнем раніше (${pct}).`,
    numbers: [a, b, pct],
  };
}

export function intensityLeftText(minutes: number, goal: number, left: number, pace: number): TemplateText {
  const m = formatNumber(minutes);
  const g = formatNumber(goal);
  const l = formatNumber(left);
  const p = formatNumber(pace);
  return {
    template: `Інтенсивних хвилин цього тижня ${m} з ${g}: лишилось ${l}, це ${p} хв на день до неділі.`,
    numbers: [m, g, l, p],
  };
}

export function intensityDoneText(minutes: number, goal: number): TemplateText {
  const m = formatNumber(minutes);
  const g = formatNumber(goal);
  return {
    template: `Тижнева ціль інтенсивності закрита: ${m} хв з ${g}, чудова робота.`,
    numbers: [m, g],
  };
}

export function streakText(days: number): TemplateText {
  return {
    template: `${days} ${plural(days, DAYS)} поспіль кроки вище цілі, так тримати.`,
    numbers: [String(days)],
  };
}

export function streakBrokenText(days: number): TemplateText {
  return {
    template: `Серія з ${days} ${plural(days, DAYS)} із кроками вище цілі вчора перервалась, сьогодні можна почати нову.`,
    numbers: [String(days)],
  };
}

export type RecordMetric = 'hrv' | 'steps' | 'floors';

export function recordText(metric: RecordMetric, value: number): TemplateText {
  if (metric === 'hrv') {
    const v = formatNumber(value);
    return { template: `HRV ${v} мс - найвищий за 30 днів.`, numbers: [v] };
  }
  if (metric === 'steps') {
    const v = formatSteps(value);
    return { template: `Вчора ${v} кроків - найбільше за 30 днів.`, numbers: [v] };
  }
  const v = formatNumber(value);
  return { template: `Вчора ${v} ${plural(value, ['поверх', 'поверхи', 'поверхів'])} - рекорд за 30 днів.`, numbers: [v] };
}

export type InfoFact = 'steps-week' | 'sleep-avg' | 'floors-30' | 'active-calories-30' | 'best-weekday';

const WEEKDAY_LOCATIVE = ['понеділках', 'вівторках', 'середах', 'четвергах', "п'ятницях", 'суботах', 'неділях'];

export function infoText(fact: InfoFact, value: number, weekdayIndex = 0): TemplateText {
  switch (fact) {
    case 'steps-week': {
      const v = formatSteps(value);
      return { template: `За 4 тижні ти в середньому проходиш ${v} кроків на тиждень.`, numbers: [v] };
    }
    case 'sleep-avg': {
      const v = formatDuration(value);
      return { template: `Середній сон за 30 днів: ${v} на ніч.`, numbers: [v] };
    }
    case 'floors-30': {
      const v = formatSteps(value);
      return { template: `За 30 днів набралось ${v} ${plural(value, ['поверх', 'поверхи', 'поверхів'])} угору.`, numbers: [v] };
    }
    case 'active-calories-30': {
      const v = formatSteps(value);
      return { template: `За 30 днів набралось ${v} активних калорій.`, numbers: [v] };
    }
    case 'best-weekday': {
      const v = formatSteps(value);
      return {
        template: `Найбільше кроків у тебе по ${WEEKDAY_LOCATIVE[weekdayIndex - 1] ?? ''}: у середньому ${v}.`,
        numbers: [v],
      };
    }
  }
}

/** The line shown when nothing fired and nothing is left to tell. */
export const ALL_NORMAL_LINE = 'Усе в межах твоєї норми.';
