import { jwtVerify, SignJWT } from 'jose'
import bcrypt from 'bcryptjs'
import { config } from './config'

const secretKey = new TextEncoder().encode(config.jwtSecret)

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash)
}

/** Shape of the data stored in JWTs. */
export interface TokenPayload {
  userId: string
  email: string
}

export async function signToken(payload: TokenPayload) {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secretKey)
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, secretKey)
    return payload
  } catch (error) {
    return null
  }
}
