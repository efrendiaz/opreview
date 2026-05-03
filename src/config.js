// Build a single month window {label, start, end} from a (year, monthIdx) pair.
// Re-used by getDateRange (current/previous) and getHistoryRanges (N months back).
function monthWindow(year, monthIdx) {
  // Normalise: monthIdx may be negative when going N months back; wrap year.
  const y = year + Math.floor(monthIdx / 12);
  const m = ((monthIdx % 12) + 12) % 12;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return {
    label: `${y}-${String(m + 1).padStart(2, '0')}`,
    start: start.toISOString(),
    end: end.toISOString()
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

  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const prevStart = new Date(Date.UTC(year, month - 1, 1));
  const prevEnd = start;

  const label = `${year}-${String(month + 1).padStart(2, '0')}`;
  const prevLabel = `${prevStart.getUTCFullYear()}-${String(prevStart.getUTCMonth() + 1).padStart(2, '0')}`;

  return {
    label,
    prevLabel,
    current: { start: start.toISOString(), end: end.toISOString() },
    previous: { start: prevStart.toISOString(), end: prevEnd.toISOString() }
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
