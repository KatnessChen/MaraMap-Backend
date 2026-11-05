/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { streamText } from 'ai';
import type { Response } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { ChatService } from './chat.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

type Result = { data?: unknown; error?: unknown; count?: number };

/** A chainable query that resolves to the next queued result for its table. */
function makeClient(queues: Record<string, Result[]>) {
  const writes: { table: string; op: string; value: any }[] = [];
  const client = {
    from: jest.fn((table: string) => {
      const next = () =>
        queues[table]?.shift() ?? ({ data: [], error: null } as Result);
      const query: any = {};
      for (const method of [
        'select',
        'eq',
        'neq',
        'not',
        'is',
        'gte',
        'order',
        'limit',
        'range',
      ]) {
        query[method] = jest.fn(() => query);
      }
      query.insert = jest.fn((value: unknown) => {
        writes.push({ table, op: 'insert', value });
        return query;
      });
      query.update = jest.fn((value: unknown) => {
        writes.push({ table, op: 'update', value });
        return query;
      });
      query.maybeSingle = jest.fn(() => Promise.resolve(next()));
      query.single = jest.fn(() => Promise.resolve(next()));
      query.then = (resolve: (value: Result) => unknown) => resolve(next());
      return query;
    }),
  };
  return { client, writes };
}

describe('ChatService', () => {
  let service: ChatService;
  const getClient = jest.fn();
  const pipe = jest.fn();
  const res = () =>
    ({ on: jest.fn(), writableEnded: false }) as unknown as Response;
  const options = () => (streamText as jest.Mock).mock.calls[0][0];
  const assistantInsert = (
    writes: { table: string; op: string; value: any }[],
  ) =>
    writes.find(
      (write) =>
        write.table === 'chat_messages' && write.value.role === 'assistant',
    )?.value;
  const stepUsage = {
    usage: {
      inputTokens: 1000,
      inputTokenDetails: { cacheReadTokens: 200 },
      outputTokens: 100,
      outputTokenDetails: { reasoningTokens: 40 },
    },
    toolCalls: [],
    toolResults: [],
    stepNumber: 0,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.USER_ID = 'user-1';
    process.env.GEMINI_API_KEY = 'test-key';
    (streamText as jest.Mock).mockReturnValue({
      pipeUIMessageStreamToResponse: pipe,
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: SupabaseService, useValue: { getClient } },
      ],
    }).compile();
    service = module.get(ChatService);
  });

  const newSessionQueues = (): Record<string, Result[]> => ({
    chat_sessions: [{ data: { id: SESSION_ID }, error: null }],
    chat_messages: [
      { data: [], error: null }, // history
    ],
  });

  describe('respond', () => {
    it('creates a titled session and stores the question before calling the model', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '  哪場比賽有抽筋？  ' }, res());

      expect(writes[0]).toMatchObject({
        table: 'chat_sessions',
        op: 'insert',
        value: { title: '哪場比賽有抽筋？' },
      });
      expect(writes[1]).toMatchObject({
        table: 'chat_messages',
        value: { role: 'user', content: '哪場比賽有抽筋？' },
      });
      expect(streamText).toHaveBeenCalledTimes(1);
      expect(pipe).toHaveBeenCalledTimes(1);
    });

    it('rejects a session that does not exist', async () => {
      const { client } = makeClient({
        chat_sessions: [{ data: null, error: null }],
        chat_messages: [{ data: [], error: null }],
      });
      getClient.mockReturnValue(client);

      await expect(
        service.respond({ sessionId: SESSION_ID, question: '問題' }, res()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(streamText).not.toHaveBeenCalled();
    });

    it('sends stored history in order and keeps old citations citable', async () => {
      const { client, writes } = makeClient({
        chat_sessions: [{ data: { id: SESSION_ID }, error: null }],
        chat_messages: [
          {
            // Newest first, as queried.
            data: [
              {
                role: 'assistant',
                content: '在東京 [a1b2c3d4]',
                citations: [
                  {
                    ref: 'a1b2c3d4',
                    post_id: 'p1',
                    title: '東京',
                    event_date: null,
                    is_hidden: false,
                  },
                ],
              },
              { role: 'user', content: '哪場有抽筋？', citations: [] },
            ],
            error: null,
          },
        ],
      });
      getClient.mockReturnValue(client);

      await service.respond(
        { sessionId: SESSION_ID, question: '那場幾公里？' },
        res(),
      );

      expect(options().messages.map((message) => message.content)).toEqual([
        '哪場有抽筋？',
        '在東京 [a1b2c3d4]',
        '那場幾公里？',
      ]);

      options().onChunk({
        chunk: { type: 'text-delta', text: '在 30K [a1b2c3d4]' },
      });
      await options().onFinish({ finishReason: 'stop' });
      expect(assistantInsert(writes).citations[0].post_id).toBe('p1');
    });

    it('drops a history window that would start with an answer', async () => {
      const { client } = makeClient({
        chat_sessions: [{ data: { id: SESSION_ID }, error: null }],
        chat_messages: [
          {
            data: [
              { role: 'user', content: '第二題', citations: [] },
              { role: 'assistant', content: '孤立的回答', citations: [] },
            ],
            error: null,
          },
        ],
      });
      getClient.mockReturnValue(client);

      await service.respond(
        { sessionId: SESSION_ID, question: '第三題' },
        res(),
      );

      expect(options().messages.map((message) => message.content)).toEqual([
        '第二題',
        '第三題',
      ]);
    });

    it('removes the tools on the last step so the model has to answer', async () => {
      const { client } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());

      const prepare = options().prepareStep;
      expect(prepare({ stepNumber: 0 })).toEqual({});
      const last = prepare({
        stepNumber: 9,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolName: 'get_posts' }],
          },
        ],
      });
      expect(last.activeTools).toEqual([]);
      expect(last.messages).toEqual([]);
      expect(last.system).toContain('現在不能再查資料了');
    });

    it('stores the answer with usage, cost and tool log when the run finishes', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      const run = options();
      run.onChunk({ chunk: { type: 'tool-call' } });
      run.onChunk({ chunk: { type: 'text-delta', text: '答案' } });
      run.onStepFinish({
        ...stepUsage,
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'search_posts',
            input: { keywords: [] },
          },
        ],
        toolResults: [{ toolCallId: 't1', output: { results: [1, 2] } }],
      });
      await run.onFinish({ finishReason: 'stop' });

      expect(assistantInsert(writes)).toMatchObject({
        session_id: SESSION_ID,
        content: '答案',
        status: 'done',
        finish_reason: 'stop',
        model: 'gemini-3.8-flash',
        thinking_level: 'low',
        input_tokens: 1000,
        cached_tokens: 200,
        output_tokens: 100,
        thinking_tokens: 40,
        tool_calls: [
          {
            step: 0,
            tool: 'search_posts',
            input: { keywords: [] },
            returned: 2,
          },
        ],
      });
      expect(assistantInsert(writes).cost_usd).toBeGreaterThan(0);
      expect(assistantInsert(writes).first_token_ms).toEqual(
        expect.any(Number),
      );
    });

    it('flags an answer that used the last step so it can be continued', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      const run = options();
      run.onChunk({ chunk: { type: 'text-delta', text: '查到一半' } });
      run.onStepFinish({ ...stepUsage, stepNumber: 9 });
      await run.onFinish({ finishReason: 'stop' });

      expect(assistantInsert(writes).step_limit_reached).toBe(true);
      expect(
        pipe.mock.calls[0][1].messageMetadata({ part: { type: 'finish' } })
          .stepLimitReached,
      ).toBe(true);
    });

    it('does not flag an answer that finished within the steps', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      const run = options();
      run.onChunk({ chunk: { type: 'text-delta', text: '回答' } });
      run.onStepFinish({ ...stepUsage, stepNumber: 2 });
      await run.onFinish({ finishReason: 'stop' });

      expect(assistantInsert(writes).step_limit_reached).toBe(false);
    });

    it('tells the next run what an unfinished answer already looked up', async () => {
      const { client } = makeClient({
        chat_sessions: [{ data: { id: SESSION_ID }, error: null }],
        chat_messages: [
          {
            data: [
              {
                role: 'assistant',
                content: '查到一半',
                citations: [],
                step_limit_reached: true,
                tool_calls: [{ tool: 'list_races', input: {}, returned: 12 }],
              },
              { role: 'user', content: '第一題', citations: [] },
            ],
            error: null,
          },
        ],
      });
      getClient.mockReturnValue(client);

      await service.respond(
        { sessionId: SESSION_ID, question: '繼續查詢' },
        res(),
      );

      expect(options().system).toContain('接著查還沒查的部分');
      expect(options().system).toContain('list_races {}（回傳 12 筆）');
    });

    it('leaves the prompt alone after a finished answer', async () => {
      const { client } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());

      expect(options().system).not.toContain('接著查還沒查的部分');
    });

    it('marks an answer cut off by the output limit as truncated', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      await options().onFinish({ finishReason: 'length' });

      expect(assistantInsert(writes).status).toBe('truncated');
    });

    it('keeps the partial answer when stopped', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      options().onChunk({ chunk: { type: 'text-delta', text: '說到一半' } });
      options().onStepFinish(stepUsage);
      await options().onAbort({ steps: [] });

      expect(assistantInsert(writes)).toMatchObject({
        status: 'stopped',
        content: '說到一半',
        input_tokens: 1000,
      });
    });

    it('records a failure once, even if the run also reports finishing', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      await options().onError({ error: new Error('model down') });
      await options().onFinish({ finishReason: 'error' });

      const answers = writes.filter(
        (write) => write.value.role === 'assistant',
      );
      expect(answers).toHaveLength(1);
      expect(answers[0].value).toMatchObject({
        status: 'failed',
        error: 'model down',
      });
    });

    it('aborts the run when the client goes away mid-answer', async () => {
      const { client } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);
      const response = res();

      await service.respond({ question: '問題' }, response);
      const close = (response.on as jest.Mock).mock.calls.find(
        ([event]) => event === 'close',
      )[1];
      close();

      expect(options().abortSignal.aborted).toBe(true);
    });

    it('tells the user when a run ends without any text', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      await options().onFinish({ finishReason: 'tool-calls' });

      expect(assistantInsert(writes).content).toContain('沒有整理出回答');
      expect(
        pipe.mock.calls[0][1].messageMetadata({
          part: { type: 'finish', finishReason: 'tool-calls' },
        }).replacementText,
      ).toContain('沒有整理出回答');
    });

    it('replaces a fragment stopped by the safety filter with a refusal', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      const run = options();
      run.onChunk({ chunk: { type: 'text-delta', text: '我無法' } });
      await run.onFinish({ finishReason: 'content-filter' });

      const stored = assistantInsert(writes);
      expect(stored.content).toContain('這個問題我無法回答');
      expect(stored.content).not.toBe('我無法');
      expect(stored.finish_reason).toBe('content-filter');
      expect(
        pipe.mock.calls[0][1].messageMetadata({
          part: { type: 'finish', finishReason: 'content-filter' },
        }),
      ).toEqual({
        sessionId: SESSION_ID,
        citations: [],
        createdAt: expect.any(String),
        replacementText: stored.content,
      });
    });

    it('sends the session id at the start and citations at the end of the stream', async () => {
      const { client } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      options().onChunk({ chunk: { type: 'text-delta', text: '回答' } });
      const metadata = pipe.mock.calls[0][1].messageMetadata;

      expect(metadata({ part: { type: 'start' } })).toEqual({
        sessionId: SESSION_ID,
      });
      expect(metadata({ part: { type: 'text-delta' } })).toBeUndefined();
      expect(metadata({ part: { type: 'finish' } })).toEqual({
        sessionId: SESSION_ID,
        citations: [],
        createdAt: expect.any(String),
      });
    });
  });

  describe('reading conversations', () => {
    it('lists sessions with the total', async () => {
      const { client } = makeClient({
        chat_sessions: [
          { data: [{ id: SESSION_ID, title: '問題' }], error: null, count: 1 },
        ],
      });
      getClient.mockReturnValue(client);

      await expect(service.listSessions(30, 0)).resolves.toEqual({
        data: [{ id: SESSION_ID, title: '問題', has_unread_answer: false }],
        total: 1,
      });
    });

    it('flags a session whose latest answer came after the last read', async () => {
      const session = (
        id: string,
        answer: string | null,
        read: string | null,
      ) => ({
        id,
        last_answer_at: answer,
        last_read_at: read,
      });
      const { client } = makeClient({
        chat_sessions: [
          {
            data: [
              session('new', '2026-11-03T10:00:00Z', '2026-11-03T09:00:00Z'),
              session('never-read', '2026-11-03T10:00:00Z', null),
              session('read', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z'),
              session('no-answer', null, null),
            ],
            count: 4,
            error: null,
          },
        ],
      });
      getClient.mockReturnValue(client);

      const { data } = await service.listSessions(30, 0);

      expect(data.map((row) => [row.id, row.has_unread_answer])).toEqual([
        ['new', true],
        ['never-read', true],
        ['read', false],
        ['no-answer', false],
      ]);
      expect(data[0]).not.toHaveProperty('last_read_at');
    });

    it('archives softly and restores', async () => {
      const { client, writes } = makeClient({
        chat_sessions: [
          { data: { id: SESSION_ID }, error: null },
          { data: { id: SESSION_ID }, error: null },
        ],
      });
      getClient.mockReturnValue(client);

      await service.archive(SESSION_ID);
      await service.restore(SESSION_ID);

      expect(writes[0].op).toBe('update');
      expect(writes[0].value.archived_at).toEqual(expect.any(String));
      expect(writes[1].value).toEqual({ archived_at: null });
    });

    it('404s when archiving a session that does not exist', async () => {
      const { client } = makeClient({
        chat_sessions: [{ data: null, error: null }],
      });
      getClient.mockReturnValue(client);

      await expect(service.archive(SESSION_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('records how the latest answer ended on the session', async () => {
      const { client, writes } = makeClient(newSessionQueues());
      getClient.mockReturnValue(client);

      await service.respond({ question: '問題' }, res());
      options().onChunk({ chunk: { type: 'text-delta', text: '回答' } });
      await options().onFinish({ finishReason: 'stop' });

      const touch = writes
        .filter(
          (write) => write.table === 'chat_sessions' && write.op === 'update',
        )
        .pop();
      expect(touch?.value.last_answer_status).toBe('done');
      expect(touch?.value.last_answer_at).toEqual(expect.any(String));
    });

    it('returns a session with its messages', async () => {
      const { client } = makeClient({
        chat_sessions: [
          { data: { id: SESSION_ID, title: '問題' }, error: null },
        ],
        chat_messages: [
          { data: [{ role: 'user', content: '問題' }], error: null },
        ],
      });
      getClient.mockReturnValue(client);

      await expect(service.getSession(SESSION_ID)).resolves.toMatchObject({
        id: SESSION_ID,
        messages: [{ role: 'user', content: '問題' }],
      });
    });

    it('404s for a session that does not exist', async () => {
      const { client } = makeClient({
        chat_sessions: [{ data: null, error: null }],
        chat_messages: [{ data: [], error: null }],
      });
      getClient.mockReturnValue(client);

      await expect(service.getSession(SESSION_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
