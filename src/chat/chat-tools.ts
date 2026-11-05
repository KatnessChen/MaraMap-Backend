import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { errorMessage } from '../common/error-message';
import { normalizeGlossaryKey } from '../translations/glossary-key';

const PAGE_SIZE = 50;
const MAX_POSTS_PER_READ = 10;
const EXCERPT_LENGTH = 70;
const EXCERPT_LEAD = 25;

const logger = new Logger('ChatTools');

export interface Citation {
  ref: string;
  post_id: string;
  title: string | null;
  event_date: string | null;
  is_hidden: boolean;
}

interface PostRow {
  id: string;
  title: string | null;
  content: string | null;
  event_date: string | null;
  category: string | null;
  is_hidden: boolean | null;
  is_personal_best?: boolean | null;
  metadata: Record<string, unknown> | null;
}

/** The short id the model sees and cites, so it never has to copy a full uuid. */
export function refOf(postId: string): string {
  return postId.slice(0, 8);
}

/**
 * Tracks which posts the model was actually given. Only these can be cited, so
 * an id the model made up can never turn into a link.
 */
export class CitationRegistry {
  private readonly known = new Map<string, Citation>();

  constructor(seed: Citation[] = []) {
    seed.forEach((citation) => this.known.set(citation.ref, citation));
  }

  register(post: Pick<PostRow, 'id' | 'title' | 'event_date' | 'is_hidden'>) {
    this.known.set(refOf(post.id), {
      ref: refOf(post.id),
      post_id: post.id,
      title: post.title,
      event_date: post.event_date,
      is_hidden: !!post.is_hidden,
    });
  }

  /** The known posts cited in `text`, in order of first appearance. */
  extract(text: string): Citation[] {
    const found = new Map<string, Citation>();
    for (const bracket of text.matchAll(
      /\[([0-9a-f]{8}(?:[\s,，、]+[0-9a-f]{8})*)\]/g,
    )) {
      for (const ref of bracket[1].match(/[0-9a-f]{8}/g) ?? []) {
        const citation = this.known.get(ref);
        if (citation) found.set(ref, citation);
      }
    }
    return [...found.values()];
  }
}

function excerptOf(content: string | null, keywords: string[]): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim();
  const hit = keywords.find((keyword) => text.includes(keyword));
  const start = hit ? Math.max(text.indexOf(hit) - EXCERPT_LEAD, 0) : 0;
  return text.slice(start, start + EXCERPT_LENGTH);
}

function locationOf(post: PostRow) {
  const metadata = post.metadata ?? {};
  return {
    country: metadata.country ?? null,
    city: metadata.city ?? null,
    race: metadata.race_name ?? null,
    mountain: metadata.mountain_name ?? null,
  };
}

/**
 * Rewrites tool calls and results as plain text for the last step. With the
 * calls left in the history, the model can keep calling a tool it no longer
 * has, which ends the run with no answer at all.
 */
export function withoutToolHistory(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === 'tool') {
      const results = message.content
        .filter((part) => part.type === 'tool-result')
        .map((part) => ({ tool: part.toolName, output: part.output }));
      return [
        { role: 'user', content: `工具回傳的資料：${JSON.stringify(results)}` },
      ];
    }
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      return [message];
    }
    const text = message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    return text ? [{ role: 'assistant', content: text }] : [];
  });
}

export function buildChatTools(
  client: SupabaseClient,
  userId: string,
  registry: CitationRegistry,
  includeHidden = true,
): ToolSet {
  return {
    search_posts: tool({
      description:
        '用關鍵字（字面比對，任一命中即算）和條件搜尋文章，回傳編號、標題、日期、地點、片段和總命中數。每頁 50 筆，has_more 為 true 時用 offset 翻頁。',
      inputSchema: z.object({
        keywords: z
          .array(z.string())
          .describe('要比對的詞，可給多個同義詞；只想依條件統計時可給空陣列'),
        category: z.string().optional().describe('文章分類'),
        country: z.string().optional().describe('國家的中文名稱'),
        race_name: z.string().optional().describe('賽事名稱的一部分'),
        date_from: z.string().optional().describe('起始日期，YYYY-MM-DD'),
        date_to: z.string().optional().describe('結束日期，YYYY-MM-DD'),
        offset: z.number().int().min(0).optional().describe('翻頁起點'),
      }),
      execute: async (input) => {
        const offset = input.offset ?? 0;
        const { data, error } = await client.rpc('chat_search_posts', {
          p_user_id: userId,
          p_keywords: input.keywords,
          p_category: input.category ?? null,
          p_country: input.country ?? null,
          p_race_name: input.race_name ?? null,
          p_date_from: input.date_from ?? null,
          p_date_to: input.date_to ?? null,
          p_limit: PAGE_SIZE,
          p_offset: offset,
          p_include_hidden: includeHidden,
        });
        if (error) {
          logger.error(`search_posts failed: ${error.message}`);
          return { error: '搜尋失敗，請稍後再試' };
        }
        const rows = (data ?? []) as (PostRow & { total_count: number })[];
        rows.forEach((row) => registry.register(row));
        const total = rows.length ? Number(rows[0].total_count) : 0;
        return {
          total,
          offset,
          has_more: offset + rows.length < total,
          results: rows.map((row) => ({
            ref: refOf(row.id),
            title: row.title,
            date: row.event_date,
            category: row.category,
            hidden: !!row.is_hidden,
            ...locationOf(row),
            excerpt: excerptOf(row.content, input.keywords),
          })),
        };
      },
    }),

    list_races: tool({
      description:
        '列出作者所有賽事文章的編號、賽事名稱、英文名稱（有的話）、日期、國家和分類，依日期排序。一次回傳完整清單。',
      inputSchema: z.object({}),
      execute: async () => {
        const raceQuery = client
          .from('fb_posts')
          .select('id, title, event_date, category, is_hidden, metadata')
          .eq('user_id', userId)
          .not('metadata->>race_name', 'is', null);
        const [races, translations] = await Promise.all([
          (includeHidden ? raceQuery : raceQuery.eq('is_hidden', false)).order(
            'event_date',
            { ascending: true },
          ),
          client.from('race_translations').select('zh, en'),
        ]);
        if (races.error || translations.error) {
          logger.error(
            `list_races failed: ${races.error?.message ?? translations.error?.message}`,
          );
          return { error: '讀取賽事清單失敗，請稍後再試' };
        }
        // An empty name is a post that never had a race, not a race.
        const rows = ((races.data ?? []) as PostRow[]).filter((row) =>
          String(row.metadata?.race_name ?? '').trim(),
        );
        const english = new Map(
          ((translations.data ?? []) as { zh: string; en: string }[]).map(
            ({ zh, en }) => [zh, en],
          ),
        );
        rows.forEach((row) => registry.register(row));
        return {
          total: rows.length,
          races: rows.map((row) => {
            const race = row.metadata?.race_name as string;
            return {
              ref: refOf(row.id),
              race,
              en:
                english.get(race.trim()) ??
                english.get(normalizeGlossaryKey(race)) ??
                null,
              date: row.event_date,
              country: row.metadata?.country ?? null,
              category: row.category,
            };
          }),
        };
      },
    }),

    get_posts: tool({
      description: `依編號讀取文章全文和參與者成績，一次最多 ${MAX_POSTS_PER_READ} 篇。`,
      inputSchema: z.object({
        refs: z
          .array(z.string().regex(/^[0-9a-f]{8}$/))
          .min(1)
          .max(MAX_POSTS_PER_READ)
          .describe('search_posts 回傳的文章編號'),
      }),
      execute: async ({ refs }) => {
        try {
          // A uuid prefix can't be matched with LIKE through PostgREST, but it
          // is exactly the range between these two bounds.
          const posts = await Promise.all(
            refs.map(async (ref) => {
              const query = client
                .from('fb_posts')
                .select(
                  'id, title, content, event_date, category, is_hidden, is_personal_best, metadata',
                )
                .eq('user_id', userId)
                .gte('id', `${ref}-0000-0000-0000-000000000000`)
                .lte('id', `${ref}-ffff-ffff-ffff-ffffffffffff`);
              const { data, error } = await (
                includeHidden ? query : query.eq('is_hidden', false)
              ).maybeSingle();
              if (error) throw new Error(error.message);
              return data as PostRow | null;
            }),
          );
          const found = posts.filter((post): post is PostRow => !!post);
          found.forEach((post) => registry.register(post));
          return {
            posts: found.map((post) => ({
              ref: refOf(post.id),
              title: post.title,
              date: post.event_date,
              category: post.category,
              hidden: !!post.is_hidden,
              personal_best: !!post.is_personal_best,
              ...locationOf(post),
              participants: post.metadata?.participants ?? [],
              content: post.content,
            })),
            not_found: refs.filter(
              (ref) => !found.some((post) => refOf(post.id) === ref),
            ),
          };
        } catch (err: unknown) {
          logger.error(`get_posts failed: ${errorMessage(err)}`);
          return { error: '讀取文章失敗，請稍後再試' };
        }
      },
    }),
  };
}
