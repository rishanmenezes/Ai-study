import prisma from '@/lib/prisma'
import { saveMemory } from '@/lib/hindsight'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuestionInput {
  text: string
  options: string[]
  correctOptionIndex: number
  explanation?: string
}

interface MistakeRecord {
  questionId: string
  userId: string
  topic: string
}

// ---------------------------------------------------------------------------
// Quiz creation
// ---------------------------------------------------------------------------

export async function createQuiz(
  userId: string,
  title: string,
  topic: string,
  questions: QuestionInput[],
  isAIGenerated: boolean = false,
) {
  return await prisma.quiz.create({
    data: {
      title,
      topic,
      isAIGenerated,
      userId,
      questions: {
        create: questions.map(q => ({
          text: q.text,
          options: JSON.stringify(q.options),
          correctOptionIndex: q.correctOptionIndex,
          explanation: q.explanation,
        })),
      },
    },
    include: {
      questions: true,
    },
  })
}

// ---------------------------------------------------------------------------
// Attempt recording + Hindsight memory
// ---------------------------------------------------------------------------

export async function recordAttempt(userId: string, quizId: string, answers: number[]) {
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: { questions: true },
  })

  if (!quiz) throw new Error('Quiz not found')

  // ── Fix #5: Validate answers array ────────────────────────────────────
  if (answers.length !== quiz.questions.length) {
    throw new Error(
      `Expected ${quiz.questions.length} answers but received ${answers.length}`,
    )
  }
  for (let i = 0; i < answers.length; i++) {
    if (!Number.isInteger(answers[i]) || answers[i] < 0 || answers[i] > 3) {
      throw new Error(
        `Invalid answer at index ${i}: must be an integer between 0 and 3`,
      )
    }
  }

  let score = 0
  const mistakesData: MistakeRecord[] = []

  // ── Identify correct / incorrect answers ──────────────────────────────
  quiz.questions.forEach((q, index) => {
    if (answers[index] === q.correctOptionIndex) {
      score += 1
    } else {
      mistakesData.push({
        questionId: q.id,
        userId,
        topic: quiz.topic,
      })
    }
  })

  // ── Persist attempt + mistakes to the database (existing logic) ───────
  const attempt = await prisma.attempt.create({
    data: {
      userId,
      quizId,
      score,
      total: quiz.questions.length,
      mistakes: {
        create: mistakesData,
      },
    },
  })

  // ── 🧠 Hindsight: save each mistake as a memory ──────────────────────
  // Fire-and-forget — failures are logged but never block quiz submission.
  if (mistakesData.length > 0) {
    const memoryPromises = mistakesData.map((mistake) => {
      const question = quiz.questions.find((q) => q.id === mistake.questionId)
      if (!question) return Promise.resolve()

      const parsedOptions: string[] = JSON.parse(question.options)
      const userAnswerIndex = answers[quiz.questions.indexOf(question)]
      const userAnswer = parsedOptions[userAnswerIndex] ?? 'No answer'
      const correctAnswer = parsedOptions[question.correctOptionIndex] ?? 'Unknown'

      const content =
        `User struggled with ${quiz.topic}. ` +
        `Question: ${question.text} ` +
        `User answered: "${userAnswer}". ` +
        `Correct answer: "${correctAnswer}". ` +
        (question.explanation
          ? `Explanation: ${question.explanation}.`
          : '')

      return saveMemory(userId, content, {
        type: 'quiz_mistake',
        topic: quiz.topic,
        questionId: question.id,
        quizId: quiz.id,
        timestamp: new Date().toISOString(),
      })
    })

    // Fix #8: Wait for all memory saves; catch handler prevents unhandled rejections
    Promise.allSettled(memoryPromises)
      .then((results) => {
        const failed = results.filter((r) => r.status === 'rejected')
        if (failed.length > 0) {
          console.error(
            `[hindsight] ${failed.length}/${results.length} mistake memories failed to save`,
          )
        }
      })
      .catch((err) => {
        // Safety net: should never trigger, but prevents unhandled rejections
        console.error('[hindsight] Unexpected error in memory save handler:', err)
      })
  }

  return attempt
}
