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
  | {
      status: 'pending';
      content?: string;
      title?: string | null;
      progress?: { done: number; total: number };
    }
  | { status: 'skipped' };

/** Split on the same '\n\n' boundary the frontend renders paragraphs with
 *  (LogDetailClient.tsx's `content.split('\n\n')`) so translated-chunk
 *  indices line up 1:1 with what the reader sees. */
function splitParagraphs(content: string): string[] {
  return content
    .split('\n\n')
    .map((p) => p.trim())
    .filter(Boolean);
}

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

  /**
   * Batched English-name resolution for cities not yet in city_translations
   * — used by LocationTranslationsService.resolveMissingCities() for the
   * "find every city used in a post but missing from the glossary, then
   * fill them all in" admin action. Batches many cities into one array-in
   * array-out Gemini call (same shape as translateTitles) rather than one
   * call per city like resolveProperNoun, since this runs over a genuine
   * bulk backlog rather than a single post's lazy lookup. Country is
   * included per entry as context so the model doesn't confuse same-named
   * cities in different countries. On failure the whole batch is skipped
   * (logged) rather than guessed at — a re-run of resolveMissingCities()
   * will pick up anything still missing.
   */
  async resolveCityNames(
    pairs: Array<{ countryZh: string; cityZh: string }>,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (pairs.length === 0) return map;
    const BATCH_SIZE = 25;
    const model = this.getGenAI().getGenerativeModel({
      model: MODEL_PRO,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              country: { type: SchemaType.STRING },
              city: { type: SchemaType.STRING },
              en: { type: SchemaType.STRING },
            },
            required: ['country', 'city', 'en'],
          },
        },
      },
    });
    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      const batch = pairs.slice(i, i + BATCH_SIZE);
      const input = batch.map((p) => ({
        country: p.countryZh,
        city: p.cityZh,
      }));
      const prompt =
        `Give the standard English name used internationally for each of these Chinese city names, given their country for disambiguation (some city names repeat across countries). ` +
        `Use the conventional English spelling (e.g. 京都 in 日本 -> "Kyoto"), not a literal transliteration, when one exists. ` +
        `Respond as a JSON array with one entry per input, echoing back the same "country" and "city", plus "en". ` +
        `Input: ${JSON.stringify(input)}`;
      try {
        const result = await model.generateContent(prompt);
        const parsed = JSON.parse(result.response.text()) as Array<{
          country: string;
          city: string;
          en: string;
        }>;
        for (const row of parsed) {
          if (row?.country && row?.city && row.en) {
            map.set(`${row.country}::${row.city}`, row.en);
          }
        }
      } catch (err: unknown) {
        this.logger.warn(`resolveCityNames batch failed: ${errorMessage(err)}`);
      }
    }
    return map;
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

  /** Translates ONE paragraph at a time (see triggerContentTranslation) so
   *  the reader sees the article grow paragraph-by-paragraph instead of
   *  waiting for the whole post in one long Gemini call — and so the output
   *  naturally keeps the source's paragraph boundaries instead of Gemini
   *  collapsing everything into one undifferentiated block. */
  private async translateParagraph(
    title: string,
    paragraph: string,
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
      `Translate this paragraph from a Chinese marathon/hiking/travel blog post to natural, readable English. ` +
      `This is one paragraph already split from the rest of the article, so don't add a new paragraph break at the end. ` +
      `But preserve any line breaks that already exist WITHIN it exactly as-is — e.g. if it's a list of short items or hashtags each on its own line, your translation must have the same number of lines, in the same order, one input line to one output line. Never merge separate lines into a single line, and never add extra line breaks beyond what's already there. ` +
      `Domain terms: ${DOMAIN_GLOSSARY}. ` +
      (knownNames
        ? `Use these confirmed English names verbatim wherever they appear: ${knownNames}. `
        : '') +
      `Title (already translated, for context only, do not re-translate it): ${title}\n\n` +
      `Paragraph:\n${paragraph}\n\n` +
      `Respond with JSON: {"content_en": "..."}`;
    const result = await this.callWithRetry(
      () => model.generateContent(prompt),
      'translateParagraph',
    );
    const parsed = JSON.parse(result.response.text()) as { content_en: string };
    if (!parsed?.content_en) throw new Error('Gemini returned no content_en');
    return parsed.content_en;
  }

  /**
   * The lazy, cache-on-first-view trigger — called from the public
   * POST /posts/:id/translate endpoint (both the frontend's polling loop on
   * first English read, and the admin's manual "translate now"). Each call
   * translates AT MOST ONE paragraph and returns the joined progress so far
   * — the frontend calls this repeatedly, appending each newly-translated
   * paragraph to the display, until it gets back 'done'. Progress is
   * persisted in content_translated_chunks so an abandoned mid-translation
   * (reader closes the tab) resumes from where it left off on the next
   * visit instead of re-translating already-done paragraphs.
   *
   * Any caller is allowed to (re)claim a 'pending' row and translate the
   * next chunk cooperatively — there's no "only the original claimant may
   * continue" rule, so a crashed/abandoned attempt is never stuck waiting
   * on a timeout. What prevents two concurrent callers from corrupting
   * content_translated_chunks (both reading the same doneChunks length and
   * writing the same index) is content_claimed_at doubling as an optimistic
   * -concurrency token: every call stamps it with a fresh value when it
   * claims/heartbeats the row, then writes its translated chunk back
   * conditioned on that exact stamp still being in place. If another call
   * raced in between and re-stamped it first, our write affects zero rows
   * and we re-read + return the winner's state instead of clobbering it —
   * so at most one paragraph's Gemini call is ever wasted per collision,
   * never a corrupted or shrinking chunk array. (Confirmed necessary in
   * practice, not just theoretical: React's dev-mode double-effect-mount
   * alone was enough to fire two concurrent polling loops for one reader.)
   */
  async triggerContentTranslation(
    userId: string,
    postId: string,
  ): Promise<ContentTriggerResult> {
    const client = this.supabase.getClient();
    type TranslationRow = {
      title: string | null;
      content: string | null;
      content_status: string | null;
      content_claimed_at: string | null;
      source: string | null;
      content_translated_chunks: string[] | null;
    };
    const ROW_COLUMNS =
      'title, content, content_status, content_claimed_at, source, content_translated_chunks';

    let row = (
      await client
        .from('post_translations')
        .select(ROW_COLUMNS)
        .eq('post_id', postId)
        .eq('locale', 'en')
        .maybeSingle<TranslationRow>()
    ).data;

    if (row?.content_status === 'done' && row.content) {
      return { status: 'done', content: row.content, title: row.title };
    }

    const { data: post, error: postError } = await client
      .from('fb_posts')
      .select('id, title, content, metadata')
      .eq('user_id', userId)
      .eq('id', postId)
      .maybeSingle<PostForTranslation>();
    if (postError || !post || !post.content) {
      if (row) {
        await client
          .from('post_translations')
          .update({ content_status: 'failed' })
          .eq('post_id', postId)
          .eq('locale', 'en');
      }
      return { status: 'skipped' };
    }

    const paragraphs = splitParagraphs(post.content);
    const total = paragraphs.length;
    if (total === 0) return { status: 'skipped' };

    // content_claimed_at doubles as our optimistic-concurrency token from
    // here on — see method doc. Every path below ends with `myToken` set to
    // the value WE just stamped, so the eventual chunk-append write can
    // detect whether anyone else re-stamped it first.
    let myToken: string;

    if (!row) {
      const insertToken = new Date().toISOString();
      const { error: insertError } = await client
        .from('post_translations')
        .insert({
          post_id: postId,
          locale: 'en',
          content_status: 'pending',
          content_claimed_at: insertToken,
          content_translated_chunks: [],
        });
      if (!insertError) {
        myToken = insertToken;
      } else {
        // Lost the race to create the row — join the winner's in-progress
        // state instead of starting a second copy.
        row = (
          await client
            .from('post_translations')
            .select(ROW_COLUMNS)
            .eq('post_id', postId)
            .eq('locale', 'en')
            .maybeSingle<TranslationRow>()
        ).data;
        if (row?.content_status === 'done' && row.content) {
          return { status: 'done', content: row.content, title: row.title };
        }
        myToken = new Date().toISOString();
        await client
          .from('post_translations')
          .update({ content_status: 'pending', content_claimed_at: myToken })
          .eq('post_id', postId)
          .eq('locale', 'en');
      }
    } else {
      // Row already existed (any status) — (re)claim it unconditionally.
      // No "is this claim stale" check is needed: cooperative continuation
      // means an abandoned attempt is simply picked up by the next caller,
      // never stuck waiting out a timeout.
      myToken = new Date().toISOString();
      await client
        .from('post_translations')
        .update({ content_status: 'pending', content_claimed_at: myToken })
        .eq('post_id', postId)
        .eq('locale', 'en');
    }

    const doneChunks = row?.content_translated_chunks ?? [];

    if (doneChunks.length >= total) {
      // Every paragraph already translated but content_status never got
      // flipped (e.g. a prior call wrote the last chunk then crashed) —
      // just finalize instead of re-translating anything. Idempotent, so
      // no token check needed here.
      const joined = doneChunks.join('\n\n');
      const titleEn = row?.title ?? post.title;
      await client
        .from('post_translations')
        .update({
          content: joined,
          content_status: 'done',
          source: 'machine',
          model: MODEL_FLASH,
          translated_at: new Date().toISOString(),
        })
        .eq('post_id', postId)
        .eq('locale', 'en');
      return { status: 'done', content: joined, title: titleEn };
    }

    /** Re-reads the row and reports its current state — used whenever our
     *  own write loses the optimistic-concurrency race, so the caller gets
     *  accurate state instead of our possibly-stale/duplicate attempt. */
    const reportCurrentState = async (
      fallbackTitle: string | null,
    ): Promise<ContentTriggerResult> => {
      const fresh = (
        await client
          .from('post_translations')
          .select(ROW_COLUMNS)
          .eq('post_id', postId)
          .eq('locale', 'en')
          .maybeSingle<TranslationRow>()
      ).data;
      if (fresh?.content_status === 'done' && fresh.content) {
        return { status: 'done', content: fresh.content, title: fresh.title };
      }
      const freshChunks = fresh?.content_translated_chunks ?? [];
      return {
        status: 'pending',
        content: freshChunks.join('\n\n'),
        title: fresh?.title ?? fallbackTitle,
        progress: { done: freshChunks.length, total },
      };
    };

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
        row?.title ??
        (await this.translateTitles([{ id: post.id, title: post.title }])).get(
          post.id,
        ) ??
        post.title;

      const nextIndex = doneChunks.length;
      const translatedParagraph = await this.translateParagraph(
        titleEn || post.title || '',
        paragraphs[nextIndex],
        raceNameEn,
        mountainNameEn,
      );
      const newChunks = [...doneChunks, translatedParagraph];

      if (newChunks.length === total) {
        const joined = newChunks.join('\n\n');
        const { data: written, error: doneError } = await client
          .from('post_translations')
          .update({
            title: titleEn,
            content: joined,
            content_status: 'done',
            content_translated_chunks: newChunks,
            source: 'machine',
            model: MODEL_FLASH,
            translated_at: new Date().toISOString(),
          })
          .eq('post_id', postId)
          .eq('locale', 'en')
          .eq('content_claimed_at', myToken)
          .select('post_id');
        if (doneError) throw new Error(doneError.message);
        if (!written || written.length === 0)
          return reportCurrentState(titleEn);
        return { status: 'done', content: joined, title: titleEn };
      }

      const { data: written, error: progressError } = await client
        .from('post_translations')
        .update({
          title: titleEn,
          content_translated_chunks: newChunks,
          content_claimed_at: new Date().toISOString(),
        })
        .eq('post_id', postId)
        .eq('locale', 'en')
        .eq('content_claimed_at', myToken)
        .select('post_id');
      if (progressError) throw new Error(progressError.message);
      if (!written || written.length === 0) return reportCurrentState(titleEn);
      return {
        status: 'pending',
        content: newChunks.join('\n\n'),
        title: titleEn,
        progress: { done: newChunks.length, total },
      };
    } catch (err: unknown) {
      this.logger.warn(
        `triggerContentTranslation failed for post ${postId} (chunk ${doneChunks.length}/${total}): ${errorMessage(err)}`,
      );
      // Leave content_status as 'pending' with whatever chunks already
      // succeeded — a future call retries this same paragraph instead of
      // discarding progress or getting stuck permanently 'failed'.
      return {
        status: 'pending',
        content: doneChunks.join('\n\n'),
        title: row?.title ?? null,
        progress: { done: doneChunks.length, total },
      };
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
      .update({
        content: null,
        content_status: null,
        content_claimed_at: null,
        content_translated_chunks: null,
      })
      .eq('post_id', postId)
      .eq('locale', 'en');
    if (error) {
      this.logger.warn(
        `invalidateContentIfMachineTranslated failed for ${postId}: ${error.message}`,
      );
    }
  }

  /**
   * Bulk-clears cached content translations across every post (titles are
   * untouched) — for wiping out translations produced by an older, worse
   * prompt/pipeline version so every post regenerates under the current
   * one. Defaults to skipping source='human' rows (a human-reviewed
   * translation isn't collateral damage from a pipeline change); pass
   * force=true to wipe those too.
   */
  async resetAllContentTranslations(force = false): Promise<{ count: number }> {
    const client = this.supabase.getClient();
    let query = client
      .from('post_translations')
      .update({
        content: null,
        content_status: null,
        content_claimed_at: null,
        content_translated_chunks: null,
      })
      .eq('locale', 'en')
      .not('content', 'is', null);
    if (!force) query = query.neq('source', 'human');
    const { data, error } = await query.select('post_id');
    if (error) throw new InternalServerErrorException(error.message);
    return { count: data?.length ?? 0 };
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
