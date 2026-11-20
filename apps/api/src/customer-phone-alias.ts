/** Canonicalize Nigerian mobile numbers before they are persisted as aliases. */
export function normalizeNigerianPhone(value: unknown): { e164: string; local: string } | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[\\s().-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  let national = "";
  if (/^0[789][0-9]{9}$/.test(digits)) national = digits.slice(1);
  else if (/^234[789][0-9]{9}$/.test(digits)) national = digits.slice(3);
  else if (/^[789][0-9]{9}$/.test(digits)) national = digits;
  if (!national) return null;
  return { e164: "+234" + national, local: "0" + national };
}
