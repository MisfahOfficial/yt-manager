// Channel code at the start of a task name, e.g. "V4--30 Forgotten $1 Meals..." -> "V4", "{C1--12 ...}" -> "C1".
export const codeOf = (name) => /^\s*\{?\s*([A-Za-z]{1,3}\d{1,2})\s*[-–—_:.\s}]/.exec(String(name || ''))?.[1]?.toUpperCase() || null;
// Tasks made by ClickUp automation for thumbnails are written inside braces: {C1--12 ...}
export const isAutomation = (name) => /^\s*\{/.test(String(name || ''));
// First word of the name (letters + optional digits), upper-case: "Spanish--30 ..." -> "SPANISH", "{SS1-..." -> "SS1".
export const firstToken = (name) => /^\s*\{?\s*([A-Za-z]+\d*)/.exec(String(name || ''))?.[1]?.toUpperCase() || null;
// Channel for a task given the Owner's channel list (a Map code -> channel).
export const channelOf = (name, channels) => { const t = firstToken(name); return t && channels.has(t) ? channels.get(t) : null; };
// Title text without the code prefix, lower-case, for spotting repeats. A leading number ("30 Forgotten...") is a count, not part of the idea.
export const normTitle = (name) => String(name || '').replace(/^\s*\{?\s*[A-Za-z]{1,3}\d{1,2}\s*[-–—_:.]+\s*/, '').replace(/^\d+\s+/, '').toLowerCase().replace(/[^\p{L}\p{N}$]+/gu, ' ').trim();
