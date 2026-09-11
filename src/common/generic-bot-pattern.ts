/**
 * Broad "is this any kind of non-human client" check — deliberately wider
 * than ai-crawler-patterns.ts's named AI-agent list (which exists to
 * identify *which* agent, for crawler_visits/IndexNow/translation-skip
 * logic). This one only needs a yes/no answer, for gating anything that
 * must count real humans only (e.g. page_views.human_views).
 *
 * This is the same pattern stats.service.ts used to use to split
 * human_views/bot_views, before bot_views was dropped for being
 * structurally blind to non-JS crawlers (see
 * 20260909010000_drop_page_views_bot_views.sql) — the check itself was
 * never wrong, only its old use (a second counter) was. Kept broader than
 * the AI-specific list on purpose: some AI agents (ChatGPT-User,
 * Claude-User, Perplexity-User) deliberately mimic a real browser and
 * contain neither "bot" nor "spider" nor "crawler", so ai-crawler-patterns'
 * named list is ORed in below rather than relied on alone.
 */
const GENERIC_BOT_PATTERN =
  /bot|spider|crawler|crawl|slurp|fetch|scan|check|monitor|scrape|archive|feed|reader|parser|headless|python|java|ruby|curl|wget|axios|libwww|go-http|http-client|okhttp|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|telegram|applebot|yandex|baidu|duckduck|semrush|ahrefs|mj12|dotbot|petalbot/i;

export function isLikelyBot(userAgent: string): boolean {
  return GENERIC_BOT_PATTERN.test(userAgent || '');
}
