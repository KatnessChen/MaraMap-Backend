import { computeCostUsd } from './chat-cost';

describe('computeCostUsd', () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedTokens: 400_000,
    outputTokens: 100_000,
    thinkingTokens: 50_000,
  };

  it('bills cached input at the cached rate and thinking as output', () => {
    const cost = computeCostUsd(usage, new Date('2026-12-31T00:00:00Z'));
    expect(cost).toBeCloseTo(0.6 * 0.75 + 0.4 * 0.075 + 0.1 * 3.75);
  });

  it('doubles once the introductory pricing ends', () => {
    const intro = computeCostUsd(usage, new Date('2026-12-31T23:59:59Z'));
    const standard = computeCostUsd(usage, new Date('2027-01-01T00:00:00Z'));
    expect(standard).toBeCloseTo(intro * 2);
  });
});
