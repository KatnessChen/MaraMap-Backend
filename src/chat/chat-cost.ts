export const CHAT_MODEL = 'gemini-3.8-flash';
export const CHAT_THINKING_LEVEL = 'low';

// USD per 1M tokens. Google's introductory rates end after 2026-12-31:
// https://ai.google.dev/gemini-api/docs/pricing
const INTRO_PRICE = { input: 0.75, cached: 0.075, output: 3.75 };
const STANDARD_PRICE = { input: 1.5, cached: 0.15, output: 7.5 };
const STANDARD_PRICE_FROM = Date.UTC(2027, 0, 1);

export interface ChatUsage {
  inputTokens: number;
  cachedTokens: number;
  /** Includes thinking tokens, which bill at the output rate. */
  outputTokens: number;
  thinkingTokens: number;
}

export function computeCostUsd(usage: ChatUsage, now = new Date()): number {
  const price =
    now.getTime() >= STANDARD_PRICE_FROM ? STANDARD_PRICE : INTRO_PRICE;
  const uncached = Math.max(usage.inputTokens - usage.cachedTokens, 0);
  return (
    (uncached * price.input +
      usage.cachedTokens * price.cached +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
