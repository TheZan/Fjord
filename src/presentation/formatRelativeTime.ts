const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Formats a timestamp with the runtime's locale-aware relative-time formatter. */
export function formatRelativeTime(value: string, locale: string, now = Date.now()) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;

  const difference = timestamp - now;
  const absolute = Math.abs(difference);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absolute >= YEAR
      ? [YEAR, "year"]
      : absolute >= MONTH
        ? [MONTH, "month"]
        : absolute >= WEEK
          ? [WEEK, "week"]
          : absolute >= DAY
            ? [DAY, "day"]
            : absolute >= HOUR
              ? [HOUR, "hour"]
              : absolute >= MINUTE
                ? [MINUTE, "minute"]
                : [SECOND, "second"];

  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(difference / divisor),
    unit,
  );
}
