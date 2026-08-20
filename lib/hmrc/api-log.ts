import { prisma } from '@/lib/db/prisma'
import type { HmrcEnvironment } from '../types'

// Every outbound HMRC call, written BEFORE the request goes out so a call that
// times out still leaves a trace, and completed afterwards with what came back.
//
// This table is not decoration. Production approval requires evidence that fraud
// prevention headers were sent correctly, and this IS that evidence - which is
// why 002_immutability.sql makes it write-once, and why the Authorization header
// and every token are excluded from what is recorded.

const NEVER_LOGGED = /^(authorization|cookie|set-cookie)$/i

export function safeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !NEVER_LOGGED.test(name)))
}

export async function beginApiCall(input: {
  environment: HmrcEnvironment
  method: string
  path: string
  fraudHeaders: Record<string, string>
  actorUserId?: string | null
}): Promise<string> {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "bk_hmrc_api_calls" ("environment", "method", "path", "fraud_headers", "actor_user_id")
    VALUES (
      ${input.environment}, ${input.method}, ${input.path},
      ${JSON.stringify(safeHeaders(input.fraudHeaders))}::jsonb,
      ${input.actorUserId ?? null}
    )
    RETURNING "id"
  `
  return row!.id
}

export async function completeApiCall(
  id: string,
  outcome: {
    statusCode: number | null
    durationMs: number
    correlationId?: string | null
    receiptId?: string | null
    errorCode?: string | null
    errorBody?: unknown
  },
): Promise<void> {
  // Never throws outward: losing the outcome of a call is a smaller problem than
  // turning a successful submission into an error because the log write failed.
  try {
    await prisma.$executeRaw`
      UPDATE "bk_hmrc_api_calls" SET
        "status_code"    = ${outcome.statusCode},
        "duration_ms"    = ${outcome.durationMs},
        "correlation_id" = ${outcome.correlationId ?? null},
        "receipt_id"     = ${outcome.receiptId ?? null},
        "error_code"     = ${outcome.errorCode ?? null},
        "error_body"     = ${outcome.errorBody === undefined ? null : JSON.stringify(outcome.errorBody)}::jsonb
      WHERE "id" = ${id}
    `
  } catch (error) {
    console.error('[uk-bookkeeping] could not record HMRC call outcome', error)
  }
}

export type ApiCallRow = {
  id: string
  at: Date
  environment: string
  method: string
  path: string
  status_code: number | null
  duration_ms: number | null
  correlation_id: string | null
  receipt_id: string | null
  error_code: string | null
}

export async function listRecentApiCalls(limit = 50): Promise<ApiCallRow[]> {
  return prisma.$queryRaw<ApiCallRow[]>`
    SELECT "id", "at", "environment", "method", "path", "status_code", "duration_ms",
           "correlation_id", "receipt_id", "error_code"
    FROM "bk_hmrc_api_calls" ORDER BY "at" DESC LIMIT ${Math.min(limit, 200)}
  `
}
