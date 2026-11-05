import {
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { stepCountIs, streamText } from 'ai';
import { errorMessage } from '../common/error-message';
import type { ChatGuest } from '../auth/auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CHAT_MODEL,
  CHAT_THINKING_LEVEL,
  ChatUsage,
  computeCostUsd,
} from './chat-cost';
import {
  buildContinuationNote,
  buildFinalStepPrompt,
  buildSystemPrompt,
  taipeiDate,
  type ToolCallLog,
} from './chat-prompt';
import {
  buildChatTools,
  Citation,
  CitationRegistry,
  withoutToolHistory,
} from './chat-tools';
import { ChatRequestDto } from './dto/chat-request.dto';

// Two tool rounds usually suffice; the last step always answers (see prepareStep).
const MAX_STEPS = 10;
const HISTORY_MESSAGES = 12;
const TITLE_LENGTH = 50;
// Thinking counts against this limit too, and 8,192 has cut answers off.
const MAX_OUTPUT_TOKENS = 32768;
// Gemini's safety filter can stop an answer mid-sentence, leaving a fragment.
const CONTENT_FILTER_REPLY =
  '這個問題我無法回答。我可以幫你查網站上的文章內容。';
// Shown instead of an empty bubble if a run ends without any text.
const EMPTY_ANSWER_REPLY = '這次沒有整理出回答，請換個方式再問一次。';
// All guests together, so a leaked passcode can't use up the GCP spend cap,
// which would also stop imports and translations.
const GUEST_DAILY_BUDGET_USD = 0.4;

type MessageStatus = 'done' | 'stopped' | 'truncated' | 'failed';

interface HistoryRow {
  role: 'user' | 'assistant';
  content: string;
  step_limit_reached?: boolean;
  tool_calls?: ToolCallLog[] | null;
  citations: Citation[] | null;
}

/** How many items a tool handed back, for the usage stats. */
function returnedCount(output: unknown): number | null {
  const value = output as {
    results?: unknown[];
    posts?: unknown[];
    races?: unknown[];
  } | null;
  return (
    value?.results?.length ??
    value?.posts?.length ??
    value?.races?.length ??
    null
  );
}

function replacementFor(
  finishReason: string | undefined,
  answer: string,
): string | null {
  if (finishReason === 'content-filter') return CONTENT_FILTER_REPLY;
  return answer.trim() ? null : EMPTY_ANSWER_REPLY;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private google: ReturnType<typeof createGoogleGenerativeAI> | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  private getModel() {
    if (!this.google) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
      this.google = createGoogleGenerativeAI({ apiKey });
    }
    return this.google(CHAT_MODEL);
  }

  async listSessions(
    limit: number,
    offset: number,
    archived = false,
    guestId: string | null = null,
  ) {
    const query = this.supabase
      .getClient()
      .from('chat_sessions')
      .select(
        'id, title, created_at, last_message_at, last_answer_at, last_answer_status, last_read_at, archived_at',
        { count: 'exact' },
      );
    const owned = guestId
      ? query.eq('guest_id', guestId)
      : query.is('guest_id', null);
    const { data, error, count } = await (
      archived
        ? owned.not('archived_at', 'is', null)
        : owned.is('archived_at', null)
    )
      .order('last_message_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new InternalServerErrorException(error.message);
    return {
      data: (data ?? []).map(({ last_read_at, ...session }) => ({
        ...session,
        has_unread_answer:
          !!session.last_answer_at &&
          (!last_read_at ||
            new Date(session.last_answer_at) > new Date(last_read_at)),
      })),
      total: count ?? 0,
    };
  }

  markRead(id: string, guestId: string | null = null) {
    return this.updateSession(
      id,
      { last_read_at: new Date().toISOString() },
      guestId,
    );
  }

  /** Soft delete: the conversation and its messages stay in the database. */
  archive(id: string, guestId: string | null = null) {
    return this.updateSession(
      id,
      { archived_at: new Date().toISOString() },
      guestId,
    );
  }

  restore(id: string, guestId: string | null = null) {
    return this.updateSession(id, { archived_at: null }, guestId);
  }

  private async updateSession(
    id: string,
    changes: Record<string, unknown>,
    guestId: string | null,
  ) {
    const query = this.supabase
      .getClient()
      .from('chat_sessions')
      .update(changes)
      .eq('id', id);
    const { data, error } = await (
      guestId ? query.eq('guest_id', guestId) : query.is('guest_id', null)
    )
      .select('id')
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('找不到這段對話');
    return { id };
  }

  async getSession(id: string, guestId: string | null = null) {
    const client = this.supabase.getClient();
    const sessionQuery = client
      .from('chat_sessions')
      .select('id, title, created_at, last_message_at')
      .eq('id', id);
    const [session, messages] = await Promise.all([
      (guestId
        ? sessionQuery.eq('guest_id', guestId)
        : sessionQuery.is('guest_id', null)
      ).maybeSingle(),
      client
        .from('chat_messages')
        // The raw provider error stays on the admin side.
        .select(
          `id, role, content, citations, status, ${guestId ? '' : 'error, '}created_at, step_limit_reached`,
        )
        .eq('session_id', id)
        .order('created_at', { ascending: true }),
    ]);
    if (session.error) {
      throw new InternalServerErrorException(session.error.message);
    }
    if (messages.error) {
      throw new InternalServerErrorException(messages.error.message);
    }
    if (!session.data) throw new NotFoundException('找不到這段對話');
    return { ...session.data, messages: messages.data ?? [] };
  }

  private async assertGuestBudgetLeft() {
    const { data, error } = await this.supabase
      .getClient()
      .from('chat_messages')
      .select('cost_usd, chat_sessions!inner(guest_id)')
      .not('chat_sessions.guest_id', 'is', null)
      .gte('created_at', `${taipeiDate(new Date())}T00:00:00+08:00`);
    if (error) throw new InternalServerErrorException(error.message);
    const spent = (data ?? []).reduce(
      (total, row) => total + Number(row.cost_usd ?? 0),
      0,
    );
    if (spent >= GUEST_DAILY_BUDGET_USD) {
      throw new HttpException(
        '今天的問答次數用完了，明天再來問吧。',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Read-only for admins, and includes what the guest has archived. */
  async listGuestSessions(limit: number, offset: number) {
    const { data, error, count } = await this.supabase
      .getClient()
      .from('chat_sessions')
      .select(
        'id, title, guest_nickname, created_at, last_message_at, last_answer_status, archived_at',
        { count: 'exact' },
      )
      .not('guest_id', 'is', null)
      .order('last_message_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new InternalServerErrorException(error.message);
    return { data: data ?? [], total: count ?? 0 };
  }

  async getGuestSession(id: string) {
    const client = this.supabase.getClient();
    const [session, messages] = await Promise.all([
      client
        .from('chat_sessions')
        .select(
          'id, title, guest_nickname, created_at, last_message_at, archived_at',
        )
        .eq('id', id)
        .not('guest_id', 'is', null)
        .maybeSingle(),
      client
        .from('chat_messages')
        .select('id, role, content, citations, status, error, created_at')
        .eq('session_id', id)
        .order('created_at', { ascending: true }),
    ]);
    if (session.error) {
      throw new InternalServerErrorException(session.error.message);
    }
    if (messages.error) {
      throw new InternalServerErrorException(messages.error.message);
    }
    if (!session.data) throw new NotFoundException('找不到這段對話');
    return { ...session.data, messages: messages.data ?? [] };
  }

  private async ensureSession(
    dto: ChatRequestDto,
    guest: ChatGuest | null,
  ): Promise<string> {
    const guestId = guest?.id ?? null;
    const client = this.supabase.getClient();
    if (dto.sessionId) {
      const query = client
        .from('chat_sessions')
        .select('id')
        .eq('id', dto.sessionId);
      const { data, error } = await (
        guestId ? query.eq('guest_id', guestId) : query.is('guest_id', null)
      ).maybeSingle();
      if (error) throw new InternalServerErrorException(error.message);
      if (!data) throw new NotFoundException('找不到這段對話');
      return dto.sessionId;
    }
    const { data, error } = await client
      .from('chat_sessions')
      .insert({
        title: dto.question.trim().slice(0, TITLE_LENGTH),
        ...(guest && { guest_id: guest.id, guest_nickname: guest.nickname }),
      })
      .select('id')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data.id;
  }

  /** Earlier turns only, read from the DB so a client can't rewrite history. */
  private async loadHistory(sessionId: string): Promise<HistoryRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('chat_messages')
      .select('role, content, citations, step_limit_reached, tool_calls')
      .eq('session_id', sessionId)
      .neq('status', 'failed')
      .neq('content', '')
      .order('created_at', { ascending: false })
      .limit(HISTORY_MESSAGES);
    if (error) throw new InternalServerErrorException(error.message);
    const rows = ((data ?? []) as HistoryRow[]).reverse();
    // A window that starts mid-turn would begin with an answer to nothing.
    return rows[0]?.role === 'assistant' ? rows.slice(1) : rows;
  }

  private async saveUserMessage(sessionId: string, question: string) {
    const client = this.supabase.getClient();
    const { error } = await client
      .from('chat_messages')
      .insert({ session_id: sessionId, role: 'user', content: question });
    if (error) throw new InternalServerErrorException(error.message);
    await this.touchSession(sessionId);
  }

  private async touchSession(sessionId: string, answerStatus?: MessageStatus) {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .getClient()
      .from('chat_sessions')
      .update({
        last_message_at: now,
        ...(answerStatus && {
          last_answer_at: now,
          last_answer_status: answerStatus,
        }),
      })
      .eq('id', sessionId);
    if (error) this.logger.error(`touchSession failed: ${error.message}`);
  }

  /**
   * Answers on `res` as an AI SDK UI message stream. The question is stored
   * before the model runs and the answer whenever the run ends, including a
   * stop or a failure partway through, so nothing asked is ever lost.
   */
  async respond(
    dto: ChatRequestDto,
    res: Response,
    guest: ChatGuest | null = null,
  ): Promise<void> {
    const userId = process.env.USER_ID;
    if (!userId) throw new InternalServerErrorException('Missing USER_ID');
    const audience = guest ? 'guest' : 'admin';
    if (guest) await this.assertGuestBudgetLeft();

    const question = dto.question.trim();
    const sessionId = await this.ensureSession(dto, guest);
    const history = await this.loadHistory(sessionId);
    const lastAnswer = history[history.length - 1];
    const continuation = lastAnswer?.step_limit_reached
      ? buildContinuationNote(lastAnswer.tool_calls ?? [])
      : '';
    await this.saveUserMessage(sessionId, question);

    const started = Date.now();
    let firstTokenMs: number | null = null;
    let answer = '';
    let saved = false;
    const toolCalls: ToolCallLog[] = [];
    const usage: ChatUsage = {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
    };
    const registry = new CitationRegistry(
      history.flatMap((row) => row.citations ?? []),
    );

    const saveAnswer = async (
      status: MessageStatus,
      finishReason: string | null,
      error: string | null,
    ) => {
      if (saved) return;
      saved = true;
      const { error: insertError } = await this.supabase
        .getClient()
        .from('chat_messages')
        .insert({
          session_id: sessionId,
          role: 'assistant',
          content: answer,
          citations: registry.extract(answer),
          status,
          error,
          model: CHAT_MODEL,
          thinking_level: CHAT_THINKING_LEVEL,
          tool_calls: toolCalls,
          input_tokens: usage.inputTokens,
          cached_tokens: usage.cachedTokens,
          output_tokens: usage.outputTokens,
          thinking_tokens: usage.thinkingTokens,
          cost_usd: computeCostUsd(usage),
          first_token_ms: firstTokenMs,
          latency_ms: Date.now() - started,
          finish_reason: finishReason,
          step_limit_reached: stepLimitReached,
        });
      if (insertError) {
        this.logger.error(`saveAnswer failed: ${insertError.message}`);
      }
      await this.touchSession(sessionId, status);
    };

    let stepLimitReached = false;

    // The stream's finish part and onFinish can arrive in either order.
    let replacementText: string | null = null;
    const applyReplacement = (finishReason?: string) => {
      replacementText ??= replacementFor(finishReason, answer);
      if (replacementText) answer = replacementText;
      return replacementText;
    };

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const result = streamText({
      model: this.getModel(),
      system: buildSystemPrompt(undefined, continuation, audience),
      messages: [
        ...history.map((row) => ({ role: row.role, content: row.content })),
        { role: 'user' as const, content: question },
      ],
      tools: buildChatTools(
        this.supabase.getClient(),
        userId,
        registry,
        !guest,
      ),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: abort.signal,
      stopWhen: stepCountIs(MAX_STEPS),
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: CHAT_THINKING_LEVEL } },
      },
      // toolChoice: 'none' isn't enough: the model can still call a tool, which
      // fails the whole question. See withoutToolHistory.
      prepareStep: ({ stepNumber, messages }) =>
        stepNumber === MAX_STEPS - 1
          ? {
              activeTools: [],
              system: buildFinalStepPrompt(undefined, continuation, audience),
              messages: withoutToolHistory(messages),
            }
          : {},
      onChunk: ({ chunk }) => {
        if (chunk.type !== 'text-delta') return;
        firstTokenMs ??= Date.now() - started;
        answer += chunk.text;
      },
      onStepFinish: (step) => {
        if (step.stepNumber >= MAX_STEPS - 1) stepLimitReached = true;
        usage.inputTokens += step.usage.inputTokens ?? 0;
        usage.cachedTokens +=
          step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
        usage.outputTokens += step.usage.outputTokens ?? 0;
        usage.thinkingTokens +=
          step.usage.outputTokenDetails?.reasoningTokens ?? 0;
        step.toolCalls.forEach((call) => {
          const toolResult = step.toolResults.find(
            (candidate) => candidate.toolCallId === call.toolCallId,
          );
          toolCalls.push({
            step: step.stepNumber,
            tool: call.toolName,
            input: call.input,
            returned: returnedCount(toolResult?.output),
          });
        });
      },
      onFinish: async ({ finishReason }) => {
        applyReplacement(finishReason);
        await saveAnswer(
          finishReason === 'length' ? 'truncated' : 'done',
          finishReason,
          null,
        );
      },
      onAbort: async () => {
        await saveAnswer('stopped', 'abort', null);
      },
      onError: async ({ error }) => {
        const message = errorMessage(error);
        this.logger.error(`chat stream failed: ${message}`);
        await saveAnswer('failed', 'error', message);
      },
    });

    result.pipeUIMessageStreamToResponse(res, {
      messageMetadata: ({ part }) => {
        if (part.type === 'start') return { sessionId };
        if (part.type === 'finish') {
          const replacementText = applyReplacement(part.finishReason);
          return {
            sessionId,
            citations: registry.extract(answer),
            createdAt: new Date().toISOString(),
            ...(replacementText && { replacementText }),
            ...(stepLimitReached && { stepLimitReached }),
          };
        }
        return undefined;
      },
      onError: () => '回答時發生問題，請再試一次。',
    });
  }
}
