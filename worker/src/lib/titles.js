// Channel code at the start of a task name, e.g. "V4--30 Forgotten $1 Meals..." -> "V4".
export const codeOf = (name) => /^\s*([A-Za-z]{1,3}\d{1,2})\s*[-–—_:.]/.exec(String(name || ''))?.[1]?.toUpperCase() || null;
// Title text without the code prefix, lower-cased, for spotting repeats.
// A leading number ("30 Forgotten...") is a count or index, not part of the idea, so it is ignored.
export const normTitle = (name) => String(name || '').replace(/^\s*[A-Za-z]{1,3}\d{1,2}\s*[-–—_:.]+\s*/, '').replace(/^\d+\s+/, '').toLowerCase().replace(/[^\p{L}\p{N}$]+/gu, ' ').trim();
