// Office-network check. The IP must come from the platform (CF-Connecting-IP), never from the page.
function v4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || +x > 255) return null;
    n = n * 256 + +x;
  }
  return n;
}
function v6ToBig(ip) {
  if (!ip.includes(':')) return null;
  let [head, tail] = ip.split('::');
  if (ip.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}
export function ipMatches(ip, rule) {
  if (!ip || !rule) return false;
  const [base, bitsStr] = rule.trim().split('/');
  const a4 = v4ToInt(ip), b4 = v4ToInt(base);
  if (a4 !== null && b4 !== null) {
    const bits = bitsStr === undefined ? 32 : +bitsStr;
    if (!(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((a4 & mask) >>> 0) === ((b4 & mask) >>> 0);
  }
  const a6 = v6ToBig(ip), b6 = v6ToBig(base);
  if (a6 !== null && b6 !== null) {
    const bits = bitsStr === undefined ? 128 : +bitsStr;
    if (!(bits >= 0 && bits <= 128)) return false;
    const shift = BigInt(128 - bits);
    return (a6 >> shift) === (b6 >> shift);
  }
  return false;
}
export const ipAllowed = (ip, rules) => Array.isArray(rules) && rules.some((r) => ipMatches(ip, r));
export function validIpRule(rule) {
  const [base, bits] = String(rule).trim().split('/');
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return false;
  return v4ToInt(base) !== null || v6ToBig(base) !== null;
}
