import OpenAI from 'openai'
import { config } from '@/lib/config'

const openai = new OpenAI({
  apiKey: config.openAIApiKey,
  baseURL: config.openAIBaseUrl,
})

const MODEL = 'openai/gpt-oss-120b'

// ---------------------------------------------------------------------------
// Fix #6: Input sanitisation helper
// ---------------------------------------------------------------------------

/** Max allowed length for user-supplied text inputs. */
const MAX_INPUT_LENGTH = 200

/**
 * Sanitise user input: trim, cap length, strip control characters.
 * Returns empty string if input is falsy.
 */
function sanitiseInput(input: string, maxLen = MAX_INPUT_LENGTH): string {
  if (!input) return ''
  return input
    .trim()
    .slice(0, maxLen)
    // Strip control characters (except newline/tab) and null bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

// ---------------------------------------------------------------------------
// Fix #9: Shared memory helper — fetchWeakTopics
// ---------------------------------------------------------------------------

/** Result of searching Hindsight for a user's weak topics. */
interface WeakTopicsResult {
  /** De-duplicated topic names from memory metadata. */
  topics: string[]
  /** Raw mistake/fact text from the top memories (max 5). */
  details: string[]
  /** Whether any memories were found. */
  memoryBacked: boolean
}

/**
 * Search Hindsight for a user's past mistakes and extract weak topics.
 *
 * Reused by `chatContext`, `generateStudyPlan`, and `generateRevisionQuestions`
 * to avoid duplicating the search + extraction logic.
 *
 * Returns empty results (never throws) so callers can fall back gracefully.
 */
async function fetchWeakTopics(
  userId: string,
  query: string,
  limit = 8,
): Promise<WeakTopicsResult> {
  try {
    const { searchMemory } = await import('@/lib/hindsight')
    const memoryResponse = await searchMemory(userId, query, { budget: 'mid' })
    const topMemories = memoryResponse.results.slice(0, limit)

    if (topMemories.length === 0) {
      return { topics: [], details: [], memoryBacked: false }
    }

    // Extract unique topic names from memory metadata
    const topicSet = new Set<string>()
    for (const mem of topMemories) {
      const metaTopic = mem.metadata?.topic
      if (metaTopic && metaTopic !== 'general') {
        topicSet.add(metaTopic)
      }
    }

    return {
      topics: Array.from(topicSet),
      details: topMemories.slice(0, 5).map((m) => m.text),
      memoryBacked: true,
    }
  } catch (error) {
    console.warn('[hindsight] fetchWeakTopics failed, proceeding without memory:', error)
    return { topics: [], details: [], memoryBacked: false }
  }
}

// ---------------------------------------------------------------------------
// Quiz Generation (Robust JSON handling)
// ---------------------------------------------------------------------------

/** Shape of a question returned by the LLM. */
interface GeneratedQuestion {
  text: string
  options: string[]
  correctOptionIndex: number
  explanation: string
}

/**
 * Returns a deterministic fallback quiz when the LLM output cannot be parsed.
 * Ensures the user always gets *something* instead of a 500 error.
 */
function buildFallbackQuiz(topic: string): GeneratedQuestion[] {
  return [
    {
      text: `What is the main concept behind ${topic}?`,
      options: [
        'A fundamental principle in the field',
        'A type of physical object',
        'A mathematical constant',
        'An unrelated historical event',
      ],
      correctOptionIndex: 0,
      explanation: `${topic} is a fundamental concept worth understanding deeply.`,
    },
    {
      text: `Which of the following is most closely related to ${topic}?`,
      options: [
        'Cooking techniques',
        'Core principles and applications',
        'Ancient mythology',
        'Sports statistics',
      ],
      correctOptionIndex: 1,
      explanation: `Understanding the core principles helps master ${topic}.`,
    },
    {
      text: `Why is studying ${topic} important?`,
      options: [
        'It is not important',
        'It is only useful for exams',
        'It builds foundational knowledge and critical thinking',
        'It is purely theoretical with no applications',
      ],
      correctOptionIndex: 2,
      explanation: `${topic} builds foundational knowledge applicable in many areas.`,
    },
  ]
}

/**
 * Validate that a parsed array looks like a real quiz.
 * Returns only valid questions, filtering out malformed ones.
 */
function validateQuizQuestions(questions: unknown[]): GeneratedQuestion[] {
  const valid: GeneratedQuestion[] = []

  for (const q of questions) {
    if (typeof q !== 'object' || q === null) continue
    const item = q as Record<string, unknown>

    const text = item.text ?? item.question
    if (typeof text !== 'string' || !text.trim()) continue

    const options = item.options
    if (!Array.isArray(options) || options.length < 2) continue

    const idx = Number(item.correctOptionIndex ?? item.correctAnswerIndex ?? 0)
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) continue

    valid.push({
      text: String(text),
      options: options.map(String),
      correctOptionIndex: idx,
      explanation: typeof item.explanation === 'string' ? item.explanation : '',
    })
  }

  return valid
}

export async function generateQuiz(topic: string): Promise<GeneratedQuestion[]> {
  // Sanitise topic input
  const safeTopic = sanitiseInput(topic)
  if (!safeTopic) throw new Error('Topic is required')

  // ── Strict JSON-only prompt ───────────────────────────────────────────
  const systemPrompt =
    'You are a quiz generator. You MUST return ONLY valid JSON. ' +
    'Do not include any explanation, markdown, code fences, or extra text. ' +
    'Return a JSON array and nothing else.'

  const userPrompt =
    `Generate a 5-question multiple choice quiz on the topic: "${safeTopic}".\n` +
    'Return a JSON array of objects. Each object must have:\n' +
    '- "text": the question text (string)\n' +
    '- "options": an array of exactly 4 string options\n' +
    '- "correctOptionIndex": the integer index (0-3) of the correct option\n' +
    '- "explanation": a short string explaining why the answer is correct\n\n' +
    'Return ONLY the JSON array. No markdown. No explanation.'

  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.7,
  })

  // ── Extract and clean the raw response ────────────────────────────────
  const rawText = completion.choices[0].message.content ?? ''

  if (!rawText.trim()) {
    console.error('[generateQuiz] LLM returned empty response')
    return buildFallbackQuiz(safeTopic)
  }

  let cleaned = rawText
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim()

  // If the LLM prepended text before the array, extract from first `[`
  const arrayStart = cleaned.indexOf('[')
  const arrayEnd = cleaned.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    cleaned = cleaned.slice(arrayStart, arrayEnd + 1)
  }

  // ── Safe JSON parse ───────────────────────────────────────────────────
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseError) {
    console.error('[generateQuiz] JSON parse failed. RAW AI RESPONSE:', rawText)
    console.error('[generateQuiz] Cleaned text:', cleaned)
    console.error('[generateQuiz] Parse error:', parseError)
    return buildFallbackQuiz(safeTopic)
  }

  // ── Validate structure ────────────────────────────────────────────────
  if (!Array.isArray(parsed)) {
    // Some LLMs wrap in { "questions": [...] }
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.questions)) {
      parsed = obj.questions
    } else {
      console.error('[generateQuiz] Response is not an array. RAW AI RESPONSE:', rawText)
      return buildFallbackQuiz(safeTopic)
    }
  }

  const validated = validateQuizQuestions(parsed as unknown[])

  if (validated.length === 0) {
    console.error('[generateQuiz] No valid questions after validation. RAW AI RESPONSE:', rawText)
    return buildFallbackQuiz(safeTopic)
  }

  return validated
}

// ---------------------------------------------------------------------------
// Study Plan Generation (Robust + saves to memory)
// ---------------------------------------------------------------------------

/** LLM call timeout in milliseconds. */
const LLM_TIMEOUT_MS = 30_000

/**
 * Hard-sanitise LLM output: strip ALL markdown, emojis, tables, code fences,
 * and normalise whitespace so the UI only ever receives plain text.
 */
function cleanOutput(raw: string): string {
  return raw
    // 1. Code fences
    .replace(/```(?:[\w]*)?\s*/gi, '')
    .replace(/```/g, '')
    // 2. Headings (##, ###, etc.)
    .replace(/#{1,6}\s?/g, '')
    // 3. Bold / italic markers
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    // 4. Table rows (any line containing pipes)
    .replace(/^.*\|.*$/gm, '')
    // 5. Inline backticks
    .replace(/`/g, '')
    // 6. Horizontal rules (--- or ***)
    .replace(/^[-*]{3,}$/gm, '')
    // 7. Emojis (broad Unicode ranges)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
    // 8. Collapse multiple blank lines into one
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build a basic fallback study plan when the LLM fails.
 */
function buildFallbackStudyPlan(topics: string[], examDate: string): string {
  const lines: string[] = [`Study Plan (Exam: ${examDate})`, '']

  topics.forEach((t, i) => {
    lines.push(`Day ${i + 1}:`)
    lines.push(`* Topic: ${t}`)
    lines.push('* Tasks:')
    lines.push('  * Review core concepts')
    lines.push('  * Practice with quizzes')
    lines.push('')
  })

  lines.push('Tip: Use the quiz feature to identify your weak spots.')
  return lines.join('\n')
}

export async function generateStudyPlan(
  topics: string[],
  examDate: string,
  userId?: string,
): Promise<string> {
  // Sanitise inputs
  const safeTopics = topics.map((t) => sanitiseInput(t)).filter(Boolean)
  const safeExamDate = sanitiseInput(examDate, 50)

  if (safeTopics.length === 0) {
    return buildFallbackStudyPlan(['General revision'], safeExamDate)
  }

  // Use shared helper for memory retrieval (never throws)
  let weakAreaBlock = ''

  if (userId) {
    const { topics: weakTopics, details } = await fetchWeakTopics(
      userId,
      'weak topics and mistakes',
    )

    if (weakTopics.length > 0) {
      const merged = new Set([...weakTopics, ...safeTopics])
      const bullets = Array.from(merged).map((t) => `- ${t}`).join('\n')
      weakAreaBlock =
        '\n\nStudent weak areas (based on past quiz mistakes):\n' + bullets
    }

    if (details.length > 0) {
      weakAreaBlock += '\n\nDetailed mistake history:\n' +
        details.map((d) => `- ${d}`).join('\n')
    }
  }

  // ── Build the LLM prompt ──────────────────────────────────────────────
  const systemPrompt =
    'You are an AI study planner.\n\n' +
    'STRICT RULES (MUST FOLLOW):\n' +
    '* Output MUST be plain text only\n' +
    '* DO NOT use markdown\n' +
    '* DO NOT use tables\n' +
    '* DO NOT use emojis\n' +
    '* DO NOT use symbols like |, #, **, or backticks\n' +
    '* DO NOT format text in any special way\n' +
    'If you break these rules, the response is invalid.\n\n' +
    'OUTPUT FORMAT:\n' +
    'Day 1:\n' +
    '* Topic: ...\n' +
    '* Tasks:\n' +
    '  * ...\n' +
    '  * ...\n\n' +
    'Follow this format EXACTLY.\n\n' +
    'Prioritize topics the student struggles with based on past mistakes. ' +
    'Allocate more study time to weak areas and less to strong areas. ' +
    'Be structured, realistic, and motivating.' +
    weakAreaBlock

  const userPrompt =
    `Create a study plan for a student facing an exam on ${safeExamDate}. ` +
    `They want to cover these topics: ${safeTopics.join(', ')}. ` +
    'Give a structured daily or weekly breakdown following the format in your instructions.'

  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  // ── Call LLM with timeout + try/catch ──────────────────────────────────
  let planContent: string

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

    const response = await openai.chat.completions.create(
      { model: MODEL, messages, temperature: 0.7 },
      { signal: controller.signal },
    )

    clearTimeout(timeout)

    const rawText = response.choices[0].message.content ?? ''

    if (!rawText.trim()) {
      console.error('[generateStudyPlan] LLM returned empty response')
      return buildFallbackStudyPlan(safeTopics, safeExamDate)
    }

    planContent = cleanOutput(rawText)
  } catch (error) {
    console.error('[generateStudyPlan] AI ERROR:', error)
    return buildFallbackStudyPlan(safeTopics, safeExamDate)
  }

  // ── Save the study plan to Hindsight memory (fire-and-forget) ──────────
  if (userId) {
    try {
      const { saveMemory } = await import('@/lib/hindsight')
      const summary = `Study plan generated for exam on ${safeExamDate}. ` +
        `Topics: ${safeTopics.join(', ')}.`

      saveMemory(userId, summary, {
        type: 'study_plan',
        topic: safeTopics[0] ?? 'general',
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        console.warn('[hindsight] Failed to save study plan to memory:', err)
      })
    } catch (error) {
      console.warn('[hindsight] Could not load saveMemory for study plan:', error)
    }
  }

  return planContent
}

// ---------------------------------------------------------------------------
// Chat (Robust + saves to memory)
// ---------------------------------------------------------------------------

/** Fallback when the chat LLM call fails. */
const CHAT_FALLBACK =
  "I'm having trouble accessing your personalized data right now. " +
  'Could you try again in a moment? In the meantime, feel free to ' +
  'ask me any study-related question and I\'ll do my best to help!'

export async function chatContext(
  query: string,
  pastContext: string = '',
  userId?: string,
): Promise<string> {
  // Sanitise query input
  const safeQuery = sanitiseInput(query, 500)

  if (!safeQuery) return 'Please type a question and I\'ll help you study!'

  // Use shared helper for memory retrieval (never throws)
  let memoryBlock = ''

  if (userId) {
    const { details } = await fetchWeakTopics(userId, safeQuery, 5)

    if (details.length > 0) {
      const bullets = details.map((d) => `- ${d}`).join('\n')
      memoryBlock = '\n\nRelevant past learning history:\n' + bullets
    }
  }

  // ── Build the message list ────────────────────────────────────────────
  const systemContent =
    'You are a personalized AI study tutor.\n\n' +
    'Respond in plain text only.\n' +
    '* Use short paragraphs or simple bullet points using "-"\n' +
    '* No markdown, no emojis, no special formatting\n' +
    '* DO NOT use symbols like |, #, **, or backticks\n' +
    'If you break these rules, the response is invalid.\n\n' +
    'Use the student\'s past mistakes and learning history to guide your response. ' +
    'Be helpful, encouraging, and reference their weak areas when relevant.' +
    memoryBlock

  const messages: { role: 'system' | 'assistant' | 'user'; content: string }[] = [
    { role: 'system', content: systemContent },
  ]

  if (pastContext) {
    messages.push({ role: 'assistant', content: pastContext })
  }

  messages.push({ role: 'user', content: safeQuery })

  // ── Call LLM with timeout + try/catch ──────────────────────────────────
  let aiReply: string

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

    const response = await openai.chat.completions.create(
      { model: MODEL, messages, temperature: 0.8 },
      { signal: controller.signal },
    )

    clearTimeout(timeout)

    const rawText = response.choices[0].message.content ?? ''

    if (!rawText.trim()) {
      console.error('[chatContext] LLM returned empty response')
      return CHAT_FALLBACK
    }

    aiReply = cleanOutput(rawText)
  } catch (error) {
    console.error('[chatContext] AI ERROR:', error)
    return CHAT_FALLBACK
  }

  // ── Save the Q&A pair to Hindsight memory (fire-and-forget) ────────────
  if (userId) {
    try {
      const { saveMemory } = await import('@/lib/hindsight')
      const chatContent =
        `Student asked: "${safeQuery}". Tutor replied: "${aiReply.slice(0, 500)}".`

      saveMemory(userId, chatContent, {
        type: 'chat',
        topic: 'general',
        timestamp: new Date().toISOString(),
      }).catch((err) => {
        console.warn('[hindsight] Failed to save chat to memory:', err)
      })
    } catch (error) {
      console.warn('[hindsight] Could not load saveMemory for chat:', error)
    }
  }

  return aiReply
}

// ---------------------------------------------------------------------------
// Smart Revision Mode
// ---------------------------------------------------------------------------

/** A single revision question returned by the AI. */
export interface RevisionQuestion {
  question: string
  options: [string, string, string, string]
  correctAnswerIndex: number
  explanation: string
}

/** The structured response from `generateRevisionQuestions`. */
export interface RevisionQuestionsResponse {
  questions: RevisionQuestion[]
  weakTopics: string[]
  memoryBacked: boolean
}

/**
 * Generate personalised revision questions targeting the student's weak areas.
 *
 * 1. Fetches the student's past mistake memories via fetchWeakTopics (up to 10).
 * 2. Extracts unique weak topics from memory metadata.
 * 3. Builds a prompt that forces the LLM to focus on those topics.
 * 4. Returns 5–7 medium-to-hard MCQs as structured JSON.
 *
 * If no memories are found, falls back to general revision questions.
 */
export async function generateRevisionQuestions(
  userId: string,
): Promise<RevisionQuestionsResponse> {
  // Fix #9: Use shared helper instead of inline memory search
  const { topics: weakTopics, details: mistakeDetails, memoryBacked } =
    await fetchWeakTopics(userId, 'quiz mistakes weak topics', 10)

  // ── Build prompt ──────────────────────────────────────────────────────
  const weakTopicBlock =
    weakTopics.length > 0
      ? '\n\nStudent weak topics (MUST be the focus):\n' +
        weakTopics.map((t) => `- ${t}`).join('\n')
      : '\n\nNo specific weak topics identified — generate general revision questions.'

  const mistakeBlock =
    mistakeDetails.length > 0
      ? '\n\nPast mistakes for context:\n' +
        mistakeDetails.map((d) => `- ${d}`).join('\n')
      : ''

  const systemPrompt =
    'You are an AI tutor creating revision questions focused ONLY on the student\'s weak areas. ' +
    'Difficulty: medium to slightly hard. ' +
    'Generate 5 to 7 multiple choice questions.\n' +
    'Output ONLY a valid JSON object with this exact structure:\n' +
    '{\n' +
    '  "questions": [\n' +
    '    {\n' +
    '      "question": "...",\n' +
    '      "options": ["A", "B", "C", "D"],\n' +
    '      "correctAnswerIndex": 0,\n' +
    '      "explanation": "..."\n' +
    '    }\n' +
    '  ]\n' +
    '}' +
    weakTopicBlock +
    mistakeBlock

  const userPrompt =
    weakTopics.length > 0
      ? `Create revision questions that specifically target these weak areas: ${weakTopics.join(', ')}. ` +
        'Make the questions test understanding, not just memorisation.'
      : 'Create general revision questions covering a mix of common study topics. ' +
        'Make the questions test understanding, not just memorisation.'

  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  // ── Call the LLM ──────────────────────────────────────────────────────
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.7,
  })

  // ── Parse the response ────────────────────────────────────────────────
  const rawContent = response.choices[0].message.content || '{"questions":[]}'
  try {
    const sanitized = rawContent
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim()
    const parsed: { questions: RevisionQuestion[] } = JSON.parse(sanitized)

    return {
      questions: parsed.questions ?? [],
      weakTopics,
      memoryBacked,
    }
  } catch (error) {
    console.error('[revision] Failed to parse AI revision questions:', error)
    return {
      questions: [],
      weakTopics,
      memoryBacked,
    }
  }
}
