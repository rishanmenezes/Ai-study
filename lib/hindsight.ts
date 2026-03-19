import {
  HindsightClient,
  HindsightError,
  type RecallResponse,
  type RecallResult,
  type RetainResponse,
  type Budget,
} from '@vectorize-io/hindsight-client'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HINDSIGHT_API_KEY = process.env.HINDSIGHT_API_KEY ?? ''
const HINDSIGHT_BASE_URL =
  process.env.HINDSIGHT_BASE_URL ?? 'https://api.hindsight.vectorize.io'

/**
 * The shared memory bank used by the AI Study Companion.
 * Per-user isolation is achieved with tags (`user:<id>`), so a single bank
 * is sufficient for all users.
 */
const MEMORY_BANK_ID = 'ai-study-companion'

if (!HINDSIGHT_API_KEY) {
  console.warn(
    '[hindsight] HINDSIGHT_API_KEY is not set — memory features will fail at runtime.',
  )
}

// ---------------------------------------------------------------------------
// Singleton client (reused across hot-reloads in development)
// ---------------------------------------------------------------------------

const clientSingleton = () =>
  new HindsightClient({
    baseUrl: HINDSIGHT_BASE_URL,
    apiKey: HINDSIGHT_API_KEY,
  })

declare global {
  // eslint-disable-next-line no-var
  var hindsightGlobal: HindsightClient | undefined
}

const hindsight: HindsightClient =
  globalThis.hindsightGlobal ?? clientSingleton()

if (process.env.NODE_ENV !== 'production') {
  globalThis.hindsightGlobal = hindsight
}

// ---------------------------------------------------------------------------
// Lazy bank initialisation (runs once on first memory operation)
// ---------------------------------------------------------------------------

let bankReady: Promise<void> | null = null

/** Ensures the memory bank exists before any retain/recall operation. */
function initBankOnce(): Promise<void> {
  if (!bankReady) {
    bankReady = ensureMemoryBank()
  }
  return bankReady
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The categories of memory the study companion tracks. */
export type MemoryType = 'quiz_mistake' | 'chat' | 'study_plan'

/** Structured metadata stored alongside every memory. */
export interface MemoryMetadata {
  type: MemoryType
  topic: string
  timestamp: string
  [key: string]: string // allow extra fields
}

/** A single memory returned by a search. */
export interface MemorySearchResult {
  id: string
  text: string
  factType: string
  context: string | null
  metadata: Record<string, string> | null
  tags: string[]
  entities: string[]
  occurredStart: string | null
  occurredEnd: string | null
  mentionedAt: string | null
}

/** The full response from a memory search. */
export interface MemorySearchResponse {
  results: MemorySearchResult[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds the scoping tag for a user. */
function userTag(userId: string): string {
  return `user:${userId}`
}

/**
 * Maps a raw SDK `RecallResult` into our application-level type.
 * The SDK uses snake_case in some response fields; we normalise here.
 */
function toMemorySearchResult(r: RecallResult): MemorySearchResult {
  return {
    id: r.id ?? '',
    text: r.text ?? '',
    factType: r.type ?? 'world',
    context: r.context ?? null,
    metadata: (r.metadata as Record<string, string>) ?? null,
    tags: (r.tags as string[]) ?? [],
    entities: (r.entities as string[]) ?? [],
    occurredStart: (r.occurred_start as string) ?? null,
    occurredEnd: (r.occurred_end as string) ?? null,
    mentionedAt: (r.mentioned_at as string) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a memory tied to a specific user.
 *
 * @param userId   - The user's unique identifier.
 * @param content  - The text content to memorise (free-form).
 * @param metadata - Structured metadata (type, topic, timestamp, etc.).
 *
 * @example
 * ```ts
 * await saveMemory('user_123', 'Got question on photosynthesis wrong', {
 *   type: 'quiz_mistake',
 *   topic: 'Biology',
 *   timestamp: new Date().toISOString(),
 * })
 * ```
 */
export async function saveMemory(
  userId: string,
  content: string,
  metadata?: MemoryMetadata,
): Promise<RetainResponse> {
  const now = new Date()
  const effectiveMetadata: Record<string, string> = {
    type: metadata?.type ?? 'chat',
    topic: metadata?.topic ?? 'general',
    timestamp: metadata?.timestamp ?? now.toISOString(),
    ...(metadata ?? {}),
  }

  try {
    // Ensure the memory bank exists (no-op after first call)
    await initBankOnce()

    const response = await hindsight.retain(MEMORY_BANK_ID, content, {
      timestamp: now,
      context: `${effectiveMetadata.type} — ${effectiveMetadata.topic}`,
      metadata: effectiveMetadata,
      tags: [userTag(userId), `type:${effectiveMetadata.type}`],
    })

    return response
  } catch (error) {
    if (error instanceof HindsightError) {
      console.error(
        `[hindsight] saveMemory failed (HTTP ${error.statusCode}):`,
        error.message,
        error.details,
      )
    } else {
      console.error('[hindsight] saveMemory unexpected error:', error)
    }
    throw error
  }
}

/**
 * Semantic search across a user's memories.
 *
 * Returns the most relevant memories ordered by Hindsight's multi-strategy
 * retrieval (semantic + BM25 + graph + temporal, re-ranked by cross-encoder).
 *
 * @param userId - The user whose memories to search.
 * @param query  - Natural-language search query.
 * @param options - Optional overrides for budget and fact types.
 *
 * @example
 * ```ts
 * const results = await searchMemory('user_123', 'What biology topics am I weak in?')
 * results.results.forEach(r => console.log(r.text))
 * ```
 */
export async function searchMemory(
  userId: string,
  query: string,
  options?: {
    /** Retrieval depth: 'low' (fast), 'mid' (default), 'high' (exhaustive). */
    budget?: Budget
    /** Filter by fact types: 'world', 'experience', 'observation'. */
    types?: string[]
  },
): Promise<MemorySearchResponse> {
  try {
    // Ensure the memory bank exists (no-op after first call)
    await initBankOnce()

    const response: RecallResponse = await hindsight.recall(
      MEMORY_BANK_ID,
      query,
      {
        tags: [userTag(userId)],
        tagsMatch: 'all_strict',
        budget: options?.budget ?? 'mid',
        types: options?.types,
      },
    )

    return {
      results: (response.results ?? []).map(toMemorySearchResult),
    }
  } catch (error) {
    if (error instanceof HindsightError) {
      console.error(
        `[hindsight] searchMemory failed (HTTP ${error.statusCode}):`,
        error.message,
        error.details,
      )
    } else {
      console.error('[hindsight] searchMemory unexpected error:', error)
    }
    throw error
  }
}

/**
 * Ensure the shared memory bank exists with the study-companion mission.
 * Safe to call multiple times (createBank is an upsert).
 */
export async function ensureMemoryBank(): Promise<void> {
  try {
    await hindsight.createBank(MEMORY_BANK_ID, {
      reflectMission:
        'You are the memory layer for an AI Study Companion. ' +
        'Track student quiz mistakes, chat interactions, and study plans. ' +
        'Prioritise identifying weak topics, learning patterns, and progress over time.',
      retainMission:
        'Extract study-related facts: topics studied, mistakes made, ' +
        'concepts discussed, study plans created, and learning preferences.',
      enableObservations: true,
      observationsMission:
        'Consolidate student learning patterns, recurring weak topics, ' +
        'and study progress into observations that help personalise recommendations.',
    })
  } catch (error) {
    // Bank may already exist — log but don't crash
    console.warn('[hindsight] ensureMemoryBank:', error)
  }
}

/** Re-export the client for advanced use-cases. */
export { hindsight as hindsightClient }
export type { Budget, RecallResponse, RetainResponse }
