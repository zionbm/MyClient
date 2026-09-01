const HEBREW_DIACRITICS = /[\u0591-\u05C7]/g;
const NAME_PUNCTUATION = /["'׳״`´.,()[\]{}:;!?\\/\-_]+/g;

export function normalizeCustomerName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(HEBREW_DIACRITICS, "")
    .replace(NAME_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("he-IL");
}

export function normalizeServiceAddress(value: string): string {
  return value
    .normalize("NFKC")
    .replace(HEBREW_DIACRITICS, "")
    .replace(/[.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("he-IL");
}

export function normalizeIsraeliPhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;

  let digits = compact.startsWith("+") ? compact.slice(1) : compact;
  if (digits.startsWith("00972")) digits = digits.slice(2);
  if (digits.startsWith("972")) {
    digits = digits.slice(3);
    if (digits.startsWith("0")) digits = digits.slice(1);
  } else if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  if (digits.length < 8 || digits.length > 9) return null;
  return `+972${digits}`;
}
