import { NextResponse } from 'next/server'
import { generateRevisionQuestions } from '@/services/ai.service'
import { verifyToken } from '@/lib/auth'
import { cookies } from 'next/headers'

// Fix #2: Smart Revision API route
export async function POST() {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('token')?.value
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const payload = await verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const result = await generateRevisionQuestions(payload.userId as string)

    return NextResponse.json(result)
  } catch (error) {
    console.error('[revision] Route error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
