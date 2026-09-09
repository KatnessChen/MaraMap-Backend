/**
 * Known AI agent / assistant crawler user-agent signatures.
 *
 * Deliberately narrower than stats.service.ts's BOT_PATTERN (which also
 * matches generic scripts, uptime monitors, and social-media unfurl bots
 * like facebookexternalhit/slackbot) — this list is only bots that fetch
 * content to answer or ground an AI response, since that's the traffic
 * relevant to deciding what to gate behind a paid tier.
 *
 * This list drifts as vendors ship new crawlers — cross-check against
 * https://darkvisitors.com periodically rather than treating it as final.
 */
export interface AiCrawlerPattern {
  name: string;
  pattern: RegExp;
}

export const AI_CRAWLER_PATTERNS: AiCrawlerPattern[] = [
  { name: 'GPTBot', pattern: /gptbot/i },
  { name: 'ChatGPT-User', pattern: /chatgpt-user/i },
  { name: 'OAI-SearchBot', pattern: /oai-searchbot/i },
  { name: 'ClaudeBot', pattern: /claudebot/i },
  { name: 'Claude-User', pattern: /claude-user/i },
  { name: 'Claude-SearchBot', pattern: /claude-searchbot/i },
  { name: 'anthropic-ai', pattern: /anthropic-ai/i },
  { name: 'PerplexityBot', pattern: /perplexitybot/i },
  { name: 'Perplexity-User', pattern: /perplexity-user/i },
  { name: 'Google-Extended', pattern: /google-extended/i },
  { name: 'GoogleOther', pattern: /googleother/i },
  { name: 'Bytespider', pattern: /bytespider/i },
  { name: 'CCBot', pattern: /ccbot/i },
  { name: 'Amazonbot', pattern: /amazonbot/i },
  { name: 'Applebot-Extended', pattern: /applebot-extended/i },
  { name: 'meta-externalagent', pattern: /meta-externalagent/i },
  { name: 'DuckAssistBot', pattern: /duckassistbot/i },
  { name: 'YouBot', pattern: /youbot/i },
  { name: 'Diffbot', pattern: /diffbot/i },
  { name: 'cohere-ai', pattern: /cohere-ai/i },
  { name: 'Timpibot', pattern: /timpibot/i },
];

export function matchAiCrawler(userAgent: string): AiCrawlerPattern | null {
  if (!userAgent) return null;
  return (
    AI_CRAWLER_PATTERNS.find(({ pattern }) => pattern.test(userAgent)) ?? null
  );
}
