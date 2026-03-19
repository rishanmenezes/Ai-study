import { NextResponse } from 'next/server'
import { chatContext } from '@/services/ai.service'
import { verifyToken } from '@/lib/auth'
import { cookies } from 'next/headers'

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('token')?.value
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    
    const payload = await verifyToken(token)
    if (!payload?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { query, context } = await req.json()
    if (!query) return NextResponse.json({ error: 'Query is required' }, { status: 400 })

    const response = await chatContext(query, context, payload.userId as string)

    return NextResponse.json({ response })
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
