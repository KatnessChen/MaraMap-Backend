// Real fb_posts.metadata.race_name / .mountain_name values are messy free
// text (year prefixes, the 台/臺 variant character, abbreviations) — see
// the seed migration's comments, sourced from an actual frequency query
// against this project's data. Stripping a leading 4-digit year and
// normalizing 臺->台 before the lookup catches the common cases without
// needing to seed every observed variant as its own row.
export function normalizeGlossaryKey(zh: string): string {
  return zh
    .trim()
    .replace(/^\d{4}\s*/, '')
    .replace(/臺/g, '台');
}
