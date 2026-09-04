import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { SupabaseService } from '../supabase/supabase.service';
import { errorMessage } from '../common/error-message';

// Content is bulk (~310k characters across the corpus) and only ever
// translated lazily, one post at a time, so cost/latency dominate the
// choice — Flash is the tier built for that. Titles and proper-noun
// resolution are low-volume (~17k characters total) but high-exposure, so
// Pro is worth it there. Deliberately NOT the newest Pro (gemini-3.1-pro is
// still preview-only as of 2026-09, no GA Gemini 3.x Pro exists yet) —
// preview models can be deprecated on short notice, which is a bad trade
// for a feature meant to keep working unattended.
export const MODEL_FLASH = 'gemini-3.8-flash';
export const MODEL_PRO = 'gemini-2.5-pro';

// A stuck 'pending' claim (the process that took it crashed mid-call) is
// retryable after this long — short enough that a real crash doesn't leave
// a post stuck for hours, long enough to comfortably cover the slowest
// realistic single-article translation (see planning notes: ~30s for a
// 5,000-character outlier).
const PENDING_CLAIM_TIMEOUT_MS = 90_000;

const DOMAIN_GLOSSARY = [
  '配速 = pace',
  '分組 = age group',
  '淨時間/晶片時間 = net time / chip time',
  '大會時間/槍聲時間 = gun time',
  '超馬 = ultramarathon',
  '百岳 = Hundred Peaks (Baiyue)',
  '個人最佳/PB = personal best (PB)',
  '補給站 = aid station',
  '關門時間 = cutoff time',
  '起跑 = start gun / start',
  '完賽 = finish',
].join('; ');

export interface RaceTranslation {
  zh: string;
  en: string;
  source: string;
  needs_review: boolean;
  updated_at: string;
}

export interface MountainTranslation {
  zh: string;
  en: string;
  source: string;
  needs_review: boolean;
  updated_at: string;
}

interface PostForTranslation {
  id: string;
  title: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
}

export type ContentTriggerResult =
  | { status: 'done'; content: string; title: string | null }
  | { status: 'pending' }
  | { status: 'skipped' };

@Injectable()
export class TranslationsService {
  private readonly logger = new Logger(TranslationsService.name);
  private genAI: GoogleGenerativeAI | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  private getGenAI(): GoogleGenerativeAI {
    if (!this.genAI) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('Missing GEMINI_API_KEY');
      this.genAI = new GoogleGenerativeAI(key);
    }
    return this.genAI;
  }

  // ---- Glossary maps (fetch once per request, mirrors
  // LocationTranslationsService.getCountryMap()/getCityMap()) ----

  async getRaceMap(): Promise<Record<string, string>> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('race_translations')
      .select('zh, en');
    if (error) throw new InternalServerErrorException(error.message);
    const map: Record<string, string> = {};
    for (const r of data || []) map[r.zh] = r.en;
    return map;
  }

  async getMountainMap(): Promise<Record<string, string>> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('mountain_translations')
      .select('zh, en');
    if (error) throw new InternalServerErrorException(error.message);
    const map: Record<string, string> = {};
    for (const r of data || []) map[r.zh] = r.en;
    return map;
  }

  // Real fb_posts.metadata.race_name / .mountain_name values are messy free
  // text (year prefixes, the 台/臺 variant character, abbreviations) — see
  // the seed migration's comments, sourced from an actual frequency query
  // against this project's data. Stripping a leading 4-digit year and
  // normalizing 臺->台 before the lookup catches the common cases without
  // needing to seed every observed variant as its own row.
  private normalizeGlossaryKey(zh: string): string {
    return zh
      .trim()
      .replace(/^\d{4}\s*/, '')
      .replace(/臺/g, '台');
  }

  /** Never returns null/blank — falls back to the zh string itself, same
   *  contract as FbPostsService.countryEn()/cityEn(). */
  raceEn(
    zh: string | null | undefined,
    raceMap: Record<string, string>,
  ): string | null {
    if (!zh) return null;
    const trimmed = zh.trim();
    if (!trimmed) return null;
    return (
      raceMap[trimmed] || raceMap[this.normalizeGlossaryKey(trimmed)] || trimmed
    );
  }

  mountainEn(
    zh: string | null | undefined,
    mountainMap: Record<string, string>,
  ): string | null {
    if (!zh) return null;
    const trimmed = zh.trim();
    if (!trimmed) return null;
    return (
      mountainMap[trimmed] ||
      mountainMap[this.normalizeGlossaryKey(trimmed)] ||
      trimmed
    );
  }

  /**
   * Resolves one proper noun against the glossary; if it's genuinely
   * missing, asks Gemini for a best-effort transliteration and writes it
   * back with needs_review=true so (a) the next post referencing the same
   * name reuses this answer instead of asking again, and (b) it surfaces in
   * the admin glossary review queue rather than being silently trusted.
   */
  async resolveProperNoun(
    zh: string,
    kind: 'race' | 'mountain',
  ): Promise<string> {
    const table =
      kind === 'race' ? 'race_translations' : 'mountain_translations';
    const client = this.supabase.getClient();
    const trimmed = zh.trim();
    const key = this.normalizeGlossaryKey(trimmed);

    const { data: existing } = await client
      .from(table)
      .select('zh, en')
      .in('zh', [trimmed, key]);
    const hit = (existing || [])[0];
    if (hit) return hit.en;

    const label = kind === 'race' ? 'marathon/race name' : 'mountain/peak name';
    const model = this.getGenAI().getGenerativeModel({
      model: MODEL_PRO,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: { en: { type: SchemaType.STRING } },
          required: ['en'],
        },
      },
    });
    let en = trimmed;
    try {
      const result = await model.generateContent(
        `Give the best English name for this Chinese ${label}: "${trimmed}". ` +
          `If it is a well-known international event/peak with an established English name, use that exact name. ` +
          `Otherwise give a reasonable transliteration. Respond with JSON: {"en": "..."}.`,
      );
      const parsed = JSON.parse(result.response.text());
      if (parsed?.en) en = String(parsed.en).trim();
    } catch (err: unknown) {
      this.logger.warn(
        `resolveProperNoun(${kind}) Gemini call failed for "${trimmed}": ${errorMessage(err)}`,
      );
    }

    const { error: upsertError } = await client.from(table).upsert(
      {
        zh: key,
        en,
        source: 'machine',
        needs_review: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'zh' },
    );
    if (upsertError) {
      this.logger.warn(
        `resolveProperNoun(${kind}) upsert failed for "${key}": ${upsertError.message}`,
      );
    }
    return en;
  }

  /** Batched title_en lookup for list endpoints — one query for N posts,
   *  same "fetch the map once per request" shape as country/city maps.
   *  Chunked: a single `.in('post_id', ...)` with hundreds of UUIDs can
   *  exceed PostgREST's URL length limit and fail outright — this was
   *  hit for real during the initial title backfill (a `limit=1000` list
   *  request silently came back with zero title_en on every post, because
   *  the failed query's error was being swallowed rather than checked). */
  async getTitleMap(postIds: string[]): Promise<Record<string, string>> {
    if (postIds.length === 0) return {};
    const client = this.supabase.getClient();
    const CHUNK_SIZE = 150;
    const map: Record<string, string> = {};
    for (let i = 0; i < postIds.length; i += CHUNK_SIZE) {
      const chunk = postIds.slice(i, i + CHUNK_SIZE);
      const { data, error } = await client
        .from('post_translations')
        .select('post_id, title')
        .eq('locale', 'en')
        .not('title', 'is', null)
        .in('post_id', chunk);
      if (error) {
        this.logger.warn(`getTitleMap chunk failed: ${error.message}`);
        continue;
      }
      for (const row of data || []) {
        if (row.title) map[row.post_id] = row.title;
      }
    }
    return map;
  }

  /** post_id -> content_status for every post with an 'en' translation row —
   *  used by the frontend's sitemap generator to decide which /en/log/[id]
   *  URLs are actually ready to advertise (see docs/I18N_PLAN.md's SEO
   *  section: an English URL should only be indexable once content_status
   *  is 'done', never while it's still the untranslated fallback). */
  async getContentStatusMap(): Promise<Record<string, string>> {
    const client = this.supabase.getClient();
    const { data } = await client
      .from('post_translations')
      .select('post_id, content_status')
      .eq('locale', 'en')
      .not('content_status', 'is', null);
    const map: Record<string, string> = {};
    for (const row of data || []) {
      if (row.content_status) map[row.post_id] = row.content_status;
    }
    return map;
  }

  /** Full cached translation row for a single post's detail view. */
  async getPostTranslation(postId: string): Promise<{
    title: string | null;
    content: string | null;
    content_status: string | null;
  } | null> {
    const client = this.supabase.getClient();
    const { data } = await client
      .from('post_translations')
      .select('title, content, content_status')
      .eq('post_id', postId)
      .eq('locale', 'en')
      .maybeSingle();
    return data ?? null;
  }

  // ---- Title translation (eager, cheap — every post gets one) ----

  /**
   * Translates whichever posts don't yet have an 'en' title cached — the
   * same "query what's missing" idempotent-selection shape as
   * etl_local/08_geocode/geocode-fallback.js, so this one method serves the
   * one-time 634-post backfill, a post-ZIP-import catch-up call, and (via a
   * single-post array) the manual-create path.
   */
  async translateMissingTitles(userId: string, limit = 200): Promise<number> {
    const client = this.supabase.getClient();
    const { data: posts, error } = await client
      .from('fb_posts')
      .select('id, title')
      .eq('user_id', userId)
      .order('event_date', { ascending: false })
      .limit(limit);
    if (error) throw new InternalServerErrorException(error.message);
    if (!posts || posts.length === 0) return 0;

    // Reuses getTitleMap's chunked `.in()` queries rather than an inline
    // one — a single unchunked `.in('post_id', ...)` with hundreds of UUIDs
    // silently failed against PostgREST in practice (error not checked),
    // which made this method think NOTHING was translated yet on every
    // call and re-translate the same posts over and over without ever
    // converging on the actual backlog.
    const titleMap = await this.getTitleMap(posts.map((p) => p.id));
    const todo = posts.filter((p) => !titleMap[p.id] && p.title);
    if (todo.length === 0) return 0;

    const BATCH_SIZE = 25;
    let done = 0;
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const batch = todo.slice(i, i + BATCH_SIZE);
      const translated = await this.translateTitles(batch);
      const rows = batch.map((p) => ({
        post_id: p.id,
        locale: 'en',
        title: translated.get(p.id) || p.title,
        source: 'machine',
        model: MODEL_PRO,
        translated_at: new Date().toISOString(),
      }));
      const { error: upsertError } = await client
        .from('post_translations')
        .upsert(rows, { onConflict: 'post_id,locale' });
      if (upsertError) {
        this.logger.warn(
          `translateMissingTitles upsert failed: ${upsertError.message}`,
        );
      } else {
        done += rows.length;
      }
    }
    return done;
  }

  /** Single-post title translation — used right after a manual create so a
   *  brand-new post has an English title for list/map views immediately,
   *  without waiting for the next backfill/ZIP-import catch-up run. */
  async translateOneTitle(postId: string, title: string | null): Promise<void> {
    if (!title) return;
    const client = this.supabase.getClient();
    const { data: existing } = await client
      .from('post_translations')
      .select('source')
      .eq('post_id', postId)
      .eq('locale', 'en')
      .maybeSingle();
    // Never silently overwrite an admin's manually-corrected English title.
    if (existing?.source === 'human') return;
    const translated = await this.translateTitles([{ id: postId, title }]);
    const { error } = await client.from('post_translations').upsert(
      {
        post_id: postId,
        locale: 'en',
        title: translated.get(postId) || title,
        source: 'machine',
        model: MODEL_PRO,
        translated_at: new Date().toISOString(),
      },
      { onConflict: 'post_id,locale' },
    );
    if (error)
      this.logger.warn(
        `translateOneTitle upsert failed for ${postId}: ${error.message}`,
      );
  }

  private async translateTitles(
    posts: Array<{ id: string; title: string | null }>,
  ): Promise<Map<string, string>> {
    const model = this.getGenAI().getGenerativeModel({
      model: MODEL_PRO,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: { type: SchemaType.STRING },
              title_en: { type: SchemaType.STRING },
            },
            required: ['id', 'title_en'],
          },
        },
      },
    });
    const input = posts.map((p) => ({ id: p.id, title: p.title || '' }));
    const prompt =
      `Translate each marathon/hiking/travel blog post title from Chinese to natural English. ` +
      `Use official English event names where the title clearly names a well-known race (e.g. 東京馬拉松 -> "Tokyo Marathon"). ` +
      `Domain terms: ${DOMAIN_GLOSSARY}. ` +
      `Respond as a JSON array with one entry per input, same "id", in any order. ` +
      `Input: ${JSON.stringify(input)}`;
    const map = new Map<string, string>();
    try {
      const result = await model.generateContent(prompt);
      const parsed = JSON.parse(result.response.text()) as Array<{
        id: string;
        title_en: string;
      }>;
      for (const row of parsed) {
        if (row?.id && row.title_en) map.set(row.id, row.title_en);
      }
    } catch (err: unknown) {
      this.logger.warn(`translateTitles batch failed: ${errorMessage(err)}`);
    }
    return map;
  }

  // ---- Content translation (lazy, single post) ----

  private async callWithRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const message = errorMessage(err);
        const retryable =
          message.includes('503') || message.includes('Service Unavailable');
        if (attempt < MAX_RETRIES && retryable) {
          const wait = attempt * 3;
          this.logger.warn(
            `${label}: retrying in ${wait}s (attempt ${attempt})`,
          );
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label}: exhausted retries`);
  }

  private async translateContentOnly(
    title: string,
    content: string,
    raceNameEn: string | null,
    mountainNameEn: string | null,
  ): Promise<string> {
    const model = this.getGenAI().getGenerativeModel({
      model: MODEL_FLASH,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: { content_en: { type: SchemaType.STRING } },
          required: ['content_en'],
        },
      },
    });
    const knownNames = [
      raceNameEn ? `race name -> "${raceNameEn}"` : null,
      mountainNameEn ? `mountain/peak name -> "${mountainNameEn}"` : null,
    ]
      .filter(Boolean)
      .join('; ');
    const prompt =
      `Translate this Chinese marathon/hiking/travel blog post to natural, readable English. ` +
      `Domain terms: ${DOMAIN_GLOSSARY}. ` +
      (knownNames
        ? `Use these confirmed English names verbatim wherever they appear: ${knownNames}. `
        : '') +
      `Title (already translated, for context only, do not re-translate it): ${title}\n\n` +
      `Content:\n${content}\n\n` +
      `Respond with JSON: {"content_en": "..."}`;
    const result = await this.callWithRetry(
      () => model.generateContent(prompt),
      'translateContentOnly',
    );
    const parsed = JSON.parse(result.response.text()) as { content_en: string };
    if (!parsed?.content_en) throw new Error('Gemini returned no content_en');
    return parsed.content_en;
  }

  /**
   * The lazy, cache-on-first-view trigger — called from the public
   * POST /posts/:id/translate endpoint (both the frontend's background
   * fetch on first English read, and the admin's manual "translate now").
   * Concurrency-safe via content_status as a claim: only the request that
   * successfully flips NULL/'failed'/stale-'pending' -> 'pending' proceeds
   * to call Gemini; everyone else gets 'pending' back immediately without
   * spending anything.
   */
  async triggerContentTranslation(
    userId: string,
    postId: string,
  ): Promise<ContentTriggerResult> {
    const client = this.supabase.getClient();

    const { data: existingRow } = await client
      .from('post_translations')
      .select('title, content, content_status, content_claimed_at, source')
      .eq('post_id', postId)
      .eq('locale', 'en')
      .maybeSingle();

    if (existingRow?.content_status === 'done' && existingRow.content) {
      return {
        status: 'done',
        content: existingRow.content,
        title: existingRow.title,
      };
    }

    const staleCutoff = new Date(
      Date.now() - PENDING_CLAIM_TIMEOUT_MS,
    ).toISOString();
    const claimedAt = new Date().toISOString();

    let claimed = false;
    if (!existingRow) {
      const { error: insertError } = await client
        .from('post_translations')
        .insert({
          post_id: postId,
          locale: 'en',
          content_status: 'pending',
          content_claimed_at: claimedAt,
        });
      // A concurrent request winning the same insert hits the (post_id,
      // locale) primary key — that's the "lost the race" signal.
      claimed = !insertError;
    } else if (
      existingRow.content_status === null ||
      existingRow.content_status === 'failed' ||
      (existingRow.content_status === 'pending' &&
        existingRow.content_claimed_at &&
        existingRow.content_claimed_at < staleCutoff)
    ) {
      const { data: updated, error: updateError } = await client
        .from('post_translations')
        .update({ content_status: 'pending', content_claimed_at: claimedAt })
        .eq('post_id', postId)
        .eq('locale', 'en')
        .or(
          `content_status.is.null,content_status.eq.failed,and(content_status.eq.pending,content_claimed_at.lt.${staleCutoff})`,
        )
        .select('post_id');
      claimed = !updateError && (updated?.length ?? 0) > 0;
    }

    if (!claimed) return { status: 'pending' };

    const { data: post, error: postError } = await client
      .from('fb_posts')
      .select('id, title, content, metadata')
      .eq('user_id', userId)
      .eq('id', postId)
      .maybeSingle<PostForTranslation>();
    if (postError || !post || !post.content) {
      await client
        .from('post_translations')
        .update({ content_status: 'failed' })
        .eq('post_id', postId)
        .eq('locale', 'en');
      return { status: 'skipped' };
    }

    try {
      const metadata = post.metadata || {};
      const [raceNameEn, mountainNameEn] = await Promise.all([
        metadata.race_name
          ? this.resolveProperNoun(String(metadata.race_name), 'race')
          : Promise.resolve(null),
        metadata.mountain_name
          ? this.resolveProperNoun(String(metadata.mountain_name), 'mountain')
          : Promise.resolve(null),
      ]);
      const titleEn =
        existingRow?.title ??
        (await this.translateTitles([{ id: post.id, title: post.title }])).get(
          post.id,
        ) ??
        post.title;
      const contentEn = await this.translateContentOnly(
        titleEn || post.title || '',
        post.content,
        raceNameEn,
        mountainNameEn,
      );
      const { error: doneError } = await client
        .from('post_translations')
        .update({
          title: titleEn,
          content: contentEn,
          content_status: 'done',
          source: 'machine',
          model: MODEL_FLASH,
          translated_at: new Date().toISOString(),
        })
        .eq('post_id', postId)
        .eq('locale', 'en');
      if (doneError) throw new Error(doneError.message);
      return { status: 'done', content: contentEn, title: titleEn };
    } catch (err: unknown) {
      this.logger.warn(
        `triggerContentTranslation failed for post ${postId}: ${errorMessage(err)}`,
      );
      await client
        .from('post_translations')
        .update({ content_status: 'failed' })
        .eq('post_id', postId)
        .eq('locale', 'en');
      return { status: 'skipped' };
    }
  }

  /** Admin override — never overwritten by the machine path afterwards. */
  async upsertHumanTranslation(
    postId: string,
    title?: string,
    content?: string,
  ): Promise<void> {
    const client = this.supabase.getClient();
    const payload: Record<string, unknown> = {
      post_id: postId,
      locale: 'en',
      source: 'human',
      reviewed_at: new Date().toISOString(),
      content_status: content !== undefined ? 'done' : undefined,
    };
    if (title !== undefined) payload.title = title;
    if (content !== undefined) payload.content = content;
    const { error } = await client
      .from('post_translations')
      .upsert(payload, { onConflict: 'post_id,locale' });
    if (error) throw new InternalServerErrorException(error.message);
  }

  /**
   * Called from FbPostsService.update() when the zh title/content changed.
   * Clears the cached machine translation so the next read re-triggers —
   * but a human-reviewed translation is never silently invalidated; an
   * admin who corrected the English text owns it until they change it
   * again.
   */
  async invalidateContentIfMachineTranslated(postId: string): Promise<void> {
    const client = this.supabase.getClient();
    const { data: row } = await client
      .from('post_translations')
      .select('source')
      .eq('post_id', postId)
      .eq('locale', 'en')
      .maybeSingle();
    if (!row || row.source === 'human') return;
    const { error } = await client
      .from('post_translations')
      .update({ content: null, content_status: null, content_claimed_at: null })
      .eq('post_id', postId)
      .eq('locale', 'en');
    if (error) {
      this.logger.warn(
        `invalidateContentIfMachineTranslated failed for ${postId}: ${error.message}`,
      );
    }
  }

  // ---- Glossary CRUD (admin review page) ----

  async listRaces(needsReviewOnly = false): Promise<RaceTranslation[]> {
    const client = this.supabase.getClient();
    let query = client
      .from('race_translations')
      .select('*')
      .order('zh', { ascending: true });
    if (needsReviewOnly) query = query.eq('needs_review', true);
    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);
    return data || [];
  }

  async upsertRace(zh: string, en: string): Promise<RaceTranslation> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('race_translations')
      .upsert(
        {
          zh: zh.trim(),
          en: en.trim(),
          source: 'human',
          needs_review: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'zh' },
      )
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async deleteRace(zh: string): Promise<void> {
    const client = this.supabase.getClient();
    const { error } = await client
      .from('race_translations')
      .delete()
      .eq('zh', zh.trim());
    if (error) throw new InternalServerErrorException(error.message);
  }

  async listMountains(needsReviewOnly = false): Promise<MountainTranslation[]> {
    const client = this.supabase.getClient();
    let query = client
      .from('mountain_translations')
      .select('*')
      .order('zh', { ascending: true });
    if (needsReviewOnly) query = query.eq('needs_review', true);
    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);
    return data || [];
  }

  async upsertMountain(zh: string, en: string): Promise<MountainTranslation> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('mountain_translations')
      .upsert(
        {
          zh: zh.trim(),
          en: en.trim(),
          source: 'human',
          needs_review: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'zh' },
      )
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async deleteMountain(zh: string): Promise<void> {
    const client = this.supabase.getClient();
    const { error } = await client
      .from('mountain_translations')
      .delete()
      .eq('zh', zh.trim());
    if (error) throw new InternalServerErrorException(error.message);
  }
}
