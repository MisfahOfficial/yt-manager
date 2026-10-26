// Asia/Karachi is UTC+5 with no DST, so a fixed offset is exact.
export const PK_OFFSET_MS = 5 * 3600 * 1000;
export const DAY_MS = 86400000;

export const localDate = (ms) => new Date(ms + PK_OFFSET_MS).toISOString().slice(0, 10);
export const localMidnightMs = (ymd) => Date.parse(ymd + 'T00:00:00Z') - PK_OFFSET_MS;
export const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
// Monday = 0 ... Sunday = 6
export const dow = (ymd) => (new Date(ymd + 'T00:00:00Z').getUTCDay() + 6) % 7;
export const localMinutes = (ms) => Math.floor((((ms + PK_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60000);
export const fmtPK = (ms) => ms == null ? '' : new Date(ms + PK_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16) + ' PKT';
export const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function weekStart(ymd) { return addDays(ymd, -dow(ymd)); }
export function periodRange(kind, period) {
  // weekly: period = Monday YYYY-MM-DD ; monthly: period = YYYY-MM
  if (kind === 'weekly') {
    if (!isYmd(period) || dow(period) !== 0) throw new Error('weekly period must be a Monday date');
    return { from: period, to: addDays(period, 6) };
  }
  if (kind === 'monthly') {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('monthly period must be YYYY-MM');
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
  }
  throw new Error('kind must be weekly or monthly');
}
export function prevPeriod(kind, period) {
  if (kind === 'weekly') return addDays(period, -7);
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
