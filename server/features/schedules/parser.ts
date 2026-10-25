import { badRequest } from '../tasks/lib.ts';

const ACCEPTED_FORMS_MSG =
  "Invalid 'when' format. Accepted forms: 'daily HH:MM', 'weekly mon..sun HH:MM', 'every N minutes' (5..1440).";

const DAY_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function validateWhenFormat(when: string): {
  type: 'daily' | 'weekly' | 'every';
  hh?: number;
  mm?: number;
  day?: string;
  minutes?: number;
} {
  const trimmed = when.trim().toLowerCase();

  const dailyMatch = /^daily\s+([01]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(trimmed);
  if (dailyMatch) {
    return {
      type: 'daily',
      hh: Number.parseInt(dailyMatch[1]!, 10),
      mm: Number.parseInt(dailyMatch[2]!, 10),
    };
  }

  const weeklyMatch = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+([01]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(
    trimmed
  );
  if (weeklyMatch) {
    return {
      type: 'weekly',
      day: weeklyMatch[1]!,
      hh: Number.parseInt(weeklyMatch[2]!, 10),
      mm: Number.parseInt(weeklyMatch[3]!, 10),
    };
  }

  const everyMatch = /^every\s+(\d+)\s+minutes?$/.exec(trimmed);
  if (everyMatch) {
    const mins = Number.parseInt(everyMatch[1]!, 10);
    if (!Number.isInteger(mins) || mins < 5 || mins > 1440) {
      throw badRequest("Interval minutes for 'every N minutes' must be between 5 and 1440.");
    }
    return {
      type: 'every',
      minutes: mins,
    };
  }

  throw badRequest(ACCEPTED_FORMS_MSG);
}

export function computeNextRunAt(when: string, fromDate = new Date()): string {
  const parsed = validateWhenFormat(when);

  if (parsed.type === 'every') {
    const nextTs = fromDate.getTime() + parsed.minutes! * 60 * 1000;
    return new Date(nextTs).toISOString();
  }

  if (parsed.type === 'daily') {
    const candidate = new Date(fromDate);
    candidate.setHours(parsed.hh!, parsed.mm!, 0, 0);
    if (candidate.getTime() <= fromDate.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.toISOString();
  }

  if (parsed.type === 'weekly') {
    const targetDay = DAY_MAP[parsed.day!]!;
    const candidate = new Date(fromDate);
    candidate.setHours(parsed.hh!, parsed.mm!, 0, 0);

    const currentDay = candidate.getDay();
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    if (daysToAdd === 0 && candidate.getTime() <= fromDate.getTime()) {
      daysToAdd = 7;
    }
    candidate.setDate(candidate.getDate() + daysToAdd);
    return candidate.toISOString();
  }

  throw badRequest(ACCEPTED_FORMS_MSG);
}
