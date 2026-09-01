export type WorkingDay = { open: string; close: string; closed?: boolean };
export type WorkingHours = Record<string, WorkingDay>;

export const AVAILABILITY_SLOT_INTERVAL_MINUTES = 30;

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  sunday: { open: "08:00", close: "18:00" },
  monday: { open: "08:00", close: "18:00" },
  tuesday: { open: "08:00", close: "18:00" },
  wednesday: { open: "08:00", close: "18:00" },
  thursday: { open: "08:00", close: "18:00" },
  friday: { open: "08:00", close: "14:00" },
  saturday: { open: "00:00", close: "00:00", closed: true }
};

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function localDateTimeToUtc(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = dateTimeParts(candidate, timezone);
    const represented = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    candidate = new Date(candidate.getTime() + desired - represented);
  }
  return candidate;
}

export function workingWindow(date: string, timezone: string, workingHours: WorkingHours) {
  const [year, month, day] = date.split("-").map(Number);
  const dayName = DAY_NAMES[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()]!;
  const configured = workingHours[dayName] ?? DEFAULT_WORKING_HOURS[dayName]!;
  if (configured.closed || configured.open === configured.close) return null;
  return {
    startsAt: localDateTimeToUtc(date, configured.open, timezone),
    endsAt: localDateTimeToUtc(date, configured.close, timezone)
  };
}

export function localDate(date: Date, timezone: string) {
  const parts = dateTimeParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function isWithinWorkingHours(
  startsAt: Date | null | undefined,
  endsAt: Date | null | undefined,
  timezone: string,
  workingHours: WorkingHours
) {
  if (!startsAt || !endsAt) return true;
  const window = workingWindow(localDate(startsAt, timezone), timezone, workingHours);
  return Boolean(window && startsAt >= window.startsAt && endsAt <= window.endsAt);
}

export function freeSlots(
  window: { startsAt: Date; endsAt: Date } | null,
  busy: Array<{ startsAt: Date; endsAt: Date }>,
  durationMinutes: number
) {
  if (!window) return [];
  const duration = durationMinutes * 60_000;
  const step = AVAILABILITY_SLOT_INTERVAL_MINUTES * 60_000;
  const slots: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (let cursor = window.startsAt.getTime(); cursor + duration <= window.endsAt.getTime(); cursor += step) {
    const end = cursor + duration;
    if (!busy.some((item) => cursor < item.endsAt.getTime() && end > item.startsAt.getTime())) {
      slots.push({ startsAt: new Date(cursor), endsAt: new Date(end) });
    }
  }
  return slots;
}
