/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildChatTools,
  CitationRegistry,
  refOf,
  withoutToolHistory,
} from './chat-tools';

const POST_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_ID = 'e5f6a7b8-0000-4000-8000-000000000002';

const row = (overrides = {}) => ({
  id: POST_ID,
  title: '東京馬拉松',
  content: '前面先跑得很順，到了 30K 雙腿開始抽筋，只好慢慢走到終點。',
  event_date: '2019-03-03',
  category: '馬拉松',
  is_hidden: false,
  is_personal_best: false,
  metadata: { country: '日本', city: '東京', race_name: '東京馬拉松' },
  total_count: 1,
  ...overrides,
});

describe('CitationRegistry', () => {
  it('only returns posts it was given, in order of first appearance', () => {
    const registry = new CitationRegistry();
    registry.register(row());
    registry.register(row({ id: OTHER_ID, title: '波士頓馬拉松' }));

    const citations = registry.extract(
      '先是 [e5f6a7b8]，再來 [a1b2c3d4]，又提到 [e5f6a7b8]，還有編造的 [deadbeef]。',
    );

    expect(citations.map((citation) => citation.ref)).toEqual([
      'e5f6a7b8',
      'a1b2c3d4',
    ]);
  });

  it('reads several ids written inside one bracket', () => {
    const registry = new CitationRegistry();
    registry.register(row());
    registry.register(row({ id: OTHER_ID }));

    expect(registry.extract('[a1b2c3d4, e5f6a7b8]')).toHaveLength(2);
  });

  it('keeps citations from earlier turns citable', () => {
    const registry = new CitationRegistry([
      {
        ref: 'a1b2c3d4',
        post_id: POST_ID,
        title: '東京馬拉松',
        event_date: '2019-03-03',
        is_hidden: true,
      },
    ]);

    expect(registry.extract('[a1b2c3d4]')[0].is_hidden).toBe(true);
  });

  it('ignores hex that is not a bracketed citation', () => {
    const registry = new CitationRegistry();
    registry.register(row());

    expect(registry.extract('編號 a1b2c3d4 沒有括號')).toEqual([]);
  });
});

describe('buildChatTools', () => {
  const rpc = jest.fn();
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    gte: jest.fn(() => query),
    lte: jest.fn(() => query),
    maybeSingle: jest.fn(),
  };
  const client = {
    rpc,
    from: jest.fn(() => query),
  } as unknown as SupabaseClient;
  const execute = (
    name: string,
    input: unknown,
    registry = new CitationRegistry(),
  ) => {
    const tools = buildChatTools(client, 'user-1', registry);
    return (tools[name] as unknown as { execute: (i: unknown) => any }).execute(
      input,
    );
  };

  beforeEach(() => jest.clearAllMocks());

  it('search_posts passes filters as bound parameters and registers results', async () => {
    rpc.mockResolvedValue({ data: [row()], error: null });
    const registry = new CitationRegistry();

    const result = await execute(
      'search_posts',
      { keywords: ['抽筋', 'a,b)'], category: '馬拉松', offset: 0 },
      registry,
    );

    expect(rpc).toHaveBeenCalledWith(
      'chat_search_posts',
      expect.objectContaining({
        p_user_id: 'user-1',
        p_keywords: ['抽筋', 'a,b)'],
        p_category: '馬拉松',
        p_country: null,
        p_limit: 50,
        p_offset: 0,
      }),
    );
    expect(result.total).toBe(1);
    expect(result.has_more).toBe(false);
    expect(result.results[0]).toMatchObject({
      ref: refOf(POST_ID),
      country: '日本',
      race: '東京馬拉松',
    });
    expect(registry.extract(`[${refOf(POST_ID)}]`)).toHaveLength(1);
  });

  it('search_posts centres the excerpt on the keyword', async () => {
    rpc.mockResolvedValue({ data: [row()], error: null });

    const result = await execute('search_posts', { keywords: ['抽筋'] });

    expect(result.results[0].excerpt).toContain('抽筋');
  });

  it('search_posts reports more pages until the total is reached', async () => {
    const rows = Array.from({ length: 50 }, () => row({ total_count: 65 }));
    rpc.mockResolvedValue({ data: rows, error: null });

    const firstPage = await execute('search_posts', { keywords: ['補給'] });
    expect(firstPage).toMatchObject({ total: 65, has_more: true });

    rpc.mockResolvedValue({
      data: rows.slice(0, 15),
      error: null,
    });
    const lastPage = await execute('search_posts', {
      keywords: ['補給'],
      offset: 50,
    });
    expect(lastPage.has_more).toBe(false);
  });

  it('search_posts handles no matches', async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    const result = await execute('search_posts', { keywords: ['火星'] });

    expect(result).toMatchObject({ total: 0, has_more: false, results: [] });
  });

  it('search_posts tells the model about a failure instead of throwing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const result = await execute('search_posts', { keywords: ['抽筋'] });

    expect(result.error).toBeDefined();
  });

  it('get_posts looks a ref up as a uuid range scoped to the user', async () => {
    query.maybeSingle.mockResolvedValue({ data: row(), error: null });
    const registry = new CitationRegistry();

    const result = await execute('get_posts', { refs: ['a1b2c3d4'] }, registry);

    expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(query.gte).toHaveBeenCalledWith(
      'id',
      'a1b2c3d4-0000-0000-0000-000000000000',
    );
    expect(query.lte).toHaveBeenCalledWith(
      'id',
      'a1b2c3d4-ffff-ffff-ffff-ffffffffffff',
    );
    expect(result.posts[0].content).toContain('抽筋');
    expect(result.not_found).toEqual([]);
    expect(registry.extract('[a1b2c3d4]')).toHaveLength(1);
  });

  it('get_posts reports refs it cannot find', async () => {
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await execute('get_posts', { refs: ['deadbeef'] });

    expect(result).toEqual({ posts: [], not_found: ['deadbeef'] });
  });

  it('get_posts tells the model about a failure instead of throwing', async () => {
    query.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });

    const result = await execute('get_posts', { refs: ['a1b2c3d4'] });

    expect(result.error).toBeDefined();
  });
});

describe('withoutToolHistory', () => {
  it('keeps what the tools returned but removes every tool call', () => {
    const flattened = withoutToolHistory([
      { role: 'user', content: '問題' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我查一下' },
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'search_posts',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: '1',
            toolName: 'search_posts',
            output: { type: 'json', value: { total: 3 } },
          },
        ],
      },
    ]);

    expect(flattened).toEqual([
      { role: 'user', content: '問題' },
      { role: 'assistant', content: '我查一下' },
      {
        role: 'user',
        content: expect.stringContaining('"total":3'),
      },
    ]);
  });
});

describe('list_races', () => {
  const clientWith = (
    races: { data: unknown; error: unknown },
    translations: { data: unknown; error: unknown },
  ) => {
    const query = (result: unknown) => {
      const chain: any = {};
      ['select', 'eq', 'not', 'order'].forEach((method) => {
        chain[method] = jest.fn(() => chain);
      });
      chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
      return chain;
    };
    return {
      from: jest.fn((table: string) =>
        query(table === 'fb_posts' ? races : translations),
      ),
    } as unknown as SupabaseClient;
  };
  const run = (client: SupabaseClient, registry: CitationRegistry) =>
    (buildChatTools(client, 'user-1', registry).list_races as any).execute({});

  it('returns every race with its English name and makes it citable', async () => {
    const registry = new CitationRegistry();
    const client = clientWith(
      {
        data: [
          row({ metadata: { race_name: '東京馬拉松', country: '日本' } }),
          row({ id: OTHER_ID, metadata: { race_name: '北竿硬地超馬' } }),
        ],
        error: null,
      },
      { data: [{ zh: '東京馬拉松', en: 'Tokyo Marathon' }], error: null },
    );

    const result = await run(client, registry);

    expect(result.total).toBe(2);
    expect(result.races[0]).toMatchObject({
      ref: 'a1b2c3d4',
      race: '東京馬拉松',
      en: 'Tokyo Marathon',
      country: '日本',
    });
    expect(result.races[1].en).toBeNull();
    expect(registry.extract('[e5f6a7b8]')).toHaveLength(1);
  });

  it('matches messy names to the glossary and drops blank ones', async () => {
    const client = clientWith(
      {
        data: [
          row({ metadata: { race_name: '2016 臺北馬拉松' } }),
          row({ id: OTHER_ID, metadata: { race_name: '' } }),
        ],
        error: null,
      },
      { data: [{ zh: '台北馬拉松', en: 'Taipei Marathon' }], error: null },
    );

    const result = await run(client, new CitationRegistry());

    expect(result.total).toBe(1);
    expect(result.races[0].en).toBe('Taipei Marathon');
  });

  it('reports a failure instead of an empty list', async () => {
    const client = clientWith(
      { data: null, error: { message: 'boom' } },
      { data: [], error: null },
    );

    await expect(run(client, new CitationRegistry())).resolves.toEqual({
      error: '讀取賽事清單失敗，請稍後再試',
    });
  });
});
