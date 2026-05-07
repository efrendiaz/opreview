// REPORT_TIMEZONE shifts the month-boundary windows from UTC midnight to local
// midnight in the given IANA timezone (e.g. "America/New_York"). Without it,
// "April 2026" runs from 2026-04-01T00:00Z to 2026-05-01T00:00Z, which can
// pull in incidents that PD's UI shows as March in the user's local time.
function tzOffsetMs(year, monthIdx, tz) {
  if (!tz) return 0;
  // Sample a date well inside the month so DST transitions on the 1st don't
  // throw off the boundary. The 15th at noon UTC is always inside the month
  // and well clear of any DST-change time-of-day in any IANA zone.
  const sampleUtc = Date.UTC(year, monthIdx, 15, 12);
  const localStr = new Date(sampleUtc).toLocaleString('sv-SE', { timeZone: tz });
  const localAsUtc = new Date(localStr.replace(' ', 'T') + 'Z');
  return localAsUtc.getTime() - sampleUtc;
}

// Build a single month window {label, start, end} from a (year, monthIdx) pair.
// Re-used by getDateRange (current/previous) and getHistoryRanges (N months back).
// Boundaries are wall-clock midnight in REPORT_TIMEZONE if set, else UTC.
function monthWindow(year, monthIdx) {
  const tz = process.env.REPORT_TIMEZONE;
  // Normalise: monthIdx may be negative when going N months back; wrap year.
  const y = year + Math.floor(monthIdx / 12);
  const m = ((monthIdx % 12) + 12) % 12;
  const startMs = Date.UTC(y, m, 1) - tzOffsetMs(y, m, tz);
  const endMs = Date.UTC(y, m + 1, 1) - tzOffsetMs(y, m + 1, tz);
  return {
    label: `${y}-${String(m + 1).padStart(2, '0')}`,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString()
  };
}

// Given a YYYY-MM string (or undefined → last full month), produce ISO-bounded
// windows for the review period and the one before it.
export function getDateRange(monthArg) {
  const now = new Date();
  let year, month; // month is 0-indexed in Date()

  if (monthArg) {
    const parts = monthArg.split('-').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid --month "${monthArg}". Expected YYYY-MM.`);
    }
    year = parts[0];
    month = parts[1] - 1;
  } else {
    // Last full month
    year = now.getUTCFullYear();
    month = now.getUTCMonth() - 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }

  const current = monthWindow(year, month);
  const previous = monthWindow(year, month - 1);

  return {
    label: current.label,
    prevLabel: previous.label,
    current: { start: current.start, end: current.end },
    previous: { start: previous.start, end: previous.end }
  };
}

// Returns `count` month windows ending at the current period (inclusive),
// oldest first — e.g. for monthArg=2026-04 and count=6, returns Nov 2025 → Apr 2026.
export function getHistoryRanges(monthArg, count) {
  const range = getDateRange(monthArg);
  const [yStr, mStr] = range.label.split('-');
  const year = Number(yStr);
  const monthIdx = Number(mStr) - 1;
  const windows = [];
  for (let i = count - 1; i >= 0; i--) {
    windows.push(monthWindow(year, monthIdx - i));
  }
  return windows;
}
