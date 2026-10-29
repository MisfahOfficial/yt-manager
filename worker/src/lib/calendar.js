// Content-calendar status for a video task, derived from its ClickUp status (via the Owner's status meanings) and its due date.
export const CAL = ['Planned', 'In Production', 'Ready', 'Uploaded', 'Missed'];
export function calStatus(status, cls, dueMs, startOfTodayMs) {
  const s = String(status || '').toLowerCase();
  let base;
  if (cls === 'ignore') base = 'Uploaded';                                   // e.g. "payment done" happens after upload
  else if (cls === 'done') base = /\bready\b|^edited\b/.test(s) ? 'Ready' : 'Uploaded';
  else if (cls === 'active' || cls === 'revision' || cls === 'paused') base = 'In Production';
  else base = 'Planned';
  // past its upload day and not uploaded = missed (Ready but not yet uploaded counts as missed too)
  if (base !== 'Uploaded' && dueMs != null && dueMs < startOfTodayMs) return 'Missed';
  return base;
}
