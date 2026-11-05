// `ai` and `@ai-sdk/google` ship ESM only, which jest's CommonJS runtime can't
// parse, so both configs map them here. Specs that exercise the model call
// override these with jest.mock().
export const streamText = jest.fn();
export const stepCountIs = jest.fn();
export const tool = jest.fn((config: unknown) => config);
export const createGoogleGenerativeAI = jest.fn(() => jest.fn());
