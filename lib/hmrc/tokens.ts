import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { encryptSecret, isEncryptionKeyUsable, tryDecryptSecret } from '@/lib/crypto/secrets'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from '../audit'
import { HmrcApiError, HmrcReauthRequiredError } from '../errors'
import type { BkHmrcConnectionRow, HmrcEnvironment } from '../types'
import type { HmrcClient, HmrcTokens } from './client'

// The token store.
//
// Tokens are encrypted at rest with core's lib/crypto/secrets.ts (AES-256-GCM
// under the per-install ENCRYPTION_KEY). A restored database carries ciphertext
// written under a DIFFERENT key, so every read goes through tryDecryptSecret and
// a null means "reconnect", not "error" - an owner who has just restored a
// backup should be told to reconnect to HMRC, not shown an OpenSSL message.

/** Refresh this far before expiry, so a call never races its own token. */
const REFRESH_MARGIN_MS = 60_000

export async function getConnection(): Promise<BkHmrcConnectionRow> {
  const rows = await prisma.$queryRaw<BkHmrcConnectionRow[]>`
    SELECT * FROM "bk_hmrc_connection" WHERE "id" = 'singleton' LIMIT 1
  `
  const row = rows[0]
  if (row) return row
  await prisma.$executeRaw`
    INSERT INTO "bk_hmrc_connection" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING
  `
  const retry = await prisma.$queryRaw<BkHmrcConnectionRow[]>`
    SELECT * FROM "bk_hmrc_connection" WHERE "id" = 'singleton' LIMIT 1
  `
  return retry[0]!
}

export async function storeTokens(input: {
  tokens: HmrcTokens
  environment: HmrcEnvironment
  vrn: string | null
  user?: SessionUser | null
}): Promise<void> {
  if (!isEncryptionKeyUsable()) {
    throw new HmrcReauthRequiredError(
      'This site has no usable encryption key, so a token cannot be stored safely.',
    )
  }
  const accessExpires = new Date(Date.now() + input.tokens.expiresIn * 1000)
  // HMRC's refresh tokens run eighteen calendar months - not eighteen lots of
  // thirty days, which is a week short and would nag the owner to reconnect
  // early. Recorded so the settings panel can say when the owner will next be
  // asked to reconnect, rather than it arriving as a surprise the week a return
  // is due.
  const refreshExpires = new Date()
  refreshExpires.setUTCMonth(refreshExpires.getUTCMonth() + 18)

  await prisma.$executeRaw`
    UPDATE "bk_hmrc_connection" SET
      "vrn"                       = ${input.vrn},
      "environment"               = ${input.environment},
      "status"                    = 'connected',
      "access_token_encrypted"    = ${encryptSecret(input.tokens.accessToken)},
      "access_token_expires_at"   = ${accessExpires},
      "refresh_token_encrypted"   = ${encryptSecret(input.tokens.refreshToken)},
      "refresh_token_expires_at"  = ${refreshExpires},
      "scope"                     = ${input.tokens.scope},
      "connected_at"              = NOW(),
      "connected_by_user_id"      = ${input.user?.id ?? null},
      "last_refresh_at"           = NOW(),
      "last_refresh_error"        = NULL,
      "updated_at"                = NOW()
    WHERE "id" = 'singleton'
  `
}

export async function disconnect(user: SessionUser | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "bk_hmrc_connection" SET
      "status" = 'never', "access_token_encrypted" = NULL, "refresh_token_encrypted" = NULL,
      "access_token_expires_at" = NULL, "refresh_token_expires_at" = NULL,
      "connected_at" = NULL, "scope" = NULL, "updated_at" = NOW()
    WHERE "id" = 'singleton'
  `
  await appendAudit({
    action: 'hmrc.disconnected',
    entityType: 'hmrc_connection',
    summary: 'Disconnected from HMRC',
    user,
  })
}

/**
 * An access token good for the next request, refreshing lazily if it is close to
 * expiry. No cron job: the request that needs a fresh token is the one that gets
 * it.
 *
 * HMRC rotate the refresh token on every use, so two requests refreshing at once
 * is a real hazard - and the VAT screen does exactly that, asking for
 * liabilities and payments side by side. The loser's refresh is refused, and on
 * 2026-09-01 it looked for the winner's new token before the winner had written
 * it, decided the connection was dead, and liabilities never reached HMRC.
 *
 * So refreshes queue. PgBouncer runs in transaction pooling mode, which rules
 * out a session advisory lock but not a row lock: the refresh runs inside a
 * transaction holding FOR UPDATE on the singleton row, and whoever waited
 * behind it re-reads that row and finds a fresh token instead of spending a
 * stale refresh token of its own.
 */
export async function getAccessToken(client: HmrcClient): Promise<{
  accessToken: string
  environment: HmrcEnvironment
  vrn: string | null
}> {
  const connection = await getConnection()

  if (connection.status === 'never' || !connection.access_token_encrypted) {
    throw new HmrcReauthRequiredError('This site is not connected to HMRC yet.')
  }

  const usable = usableAccessToken(connection)
  if (usable) return usable

  // Side effects of a failure (marking the connection expired, the audit row)
  // happen AFTER the transaction: written inside it they would roll back with
  // the throw that reports them.
  const outcome = await prisma.$transaction(
    async (tx): Promise<RefreshOutcome> => {
      const [locked] = await tx.$queryRaw<BkHmrcConnectionRow[]>`
        SELECT * FROM "bk_hmrc_connection" WHERE "id" = 'singleton' FOR UPDATE
      `
      if (!locked) return { kind: 'unreadable' }

      // Somebody refreshed while we queued for the lock.
      const queuedBehind = usableAccessToken(locked)
      if (queuedBehind) return { kind: 'ok', ...queuedBehind }

      const refreshToken = tryDecryptSecret(locked.refresh_token_encrypted)
      // Either there is no refresh token, or this install's ENCRYPTION_KEY
      // cannot read the one that is there - the restored-backup case.
      if (!refreshToken) return { kind: 'unreadable' }

      let tokens: HmrcTokens
      try {
        tokens = await client.refresh({ refreshToken, environment: locked.environment })
      } catch (error) {
        return { kind: 'failed', error }
      }

      await tx.$executeRaw`
        UPDATE "bk_hmrc_connection" SET
          "access_token_encrypted"   = ${encryptSecret(tokens.accessToken)},
          "access_token_expires_at"  = ${new Date(Date.now() + tokens.expiresIn * 1000)},
          "refresh_token_encrypted"  = ${encryptSecret(tokens.refreshToken)},
          "status"                   = 'connected',
          "last_refresh_at"          = NOW(),
          "last_refresh_error"       = NULL,
          "updated_at"               = NOW()
        WHERE "id" = 'singleton'
      `
      return {
        kind: 'ok',
        accessToken: tokens.accessToken,
        environment: locked.environment,
        vrn: locked.vrn,
      }
    },
    // The refresh is an HTTP call to HMRC made while holding the lock, so the
    // transaction must outlive the client's own 30s timeout on it.
    { timeout: 45_000, maxWait: 45_000 },
  )

  if (outcome.kind === 'ok') {
    return { accessToken: outcome.accessToken, environment: outcome.environment, vrn: outcome.vrn }
  }

  if (outcome.kind === 'unreadable') {
    // Both causes mean the same thing to the owner, and it is a sentence rather
    // than a stack trace.
    await markExpired('The stored HMRC connection cannot be read by this site.')
    throw new HmrcReauthRequiredError()
  }

  const { error } = outcome
  // A timeout or an HMRC outage is transient: the stored refresh token is very
  // likely still good, so surface the error without burning the connection to
  // 'expired' and marching the owner back through the Government Gateway for
  // nothing.
  if (error instanceof HmrcApiError && (error.httpStatus >= 500 || error.httpStatus === 429)) {
    throw error
  }
  const message = error instanceof Error ? error.message : 'Refresh failed'
  await markExpired(message)
  await appendAudit({
    action: 'hmrc.refresh-failed',
    entityType: 'hmrc_connection',
    summary: 'The HMRC connection could not be renewed',
    detail: { message },
    user: null,
  })
  throw new HmrcReauthRequiredError(message)
}

type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; environment: HmrcEnvironment; vrn: string | null }
  | { kind: 'unreadable' }
  | { kind: 'failed'; error: unknown }

/** The stored access token, if it decrypts and has more than the margin left. */
function usableAccessToken(
  row: BkHmrcConnectionRow,
): { accessToken: string; environment: HmrcEnvironment; vrn: string | null } | null {
  const accessToken = tryDecryptSecret(row.access_token_encrypted)
  const expiresAt = row.access_token_expires_at?.getTime() ?? 0
  if (!accessToken || expiresAt - Date.now() <= REFRESH_MARGIN_MS) return null
  return { accessToken, environment: row.environment, vrn: row.vrn }
}

async function markExpired(reason: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "bk_hmrc_connection"
    SET "status" = 'expired', "last_refresh_error" = ${reason.slice(0, 500)}, "updated_at" = NOW()
    WHERE "id" = 'singleton'
  `
}

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000

export async function createOauthState(input: {
  userId: string
  environment: HmrcEnvironment
  returnTo?: string | null
}): Promise<string> {
  const state = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "bk_hmrc_oauth_states" ("state", "user_id", "environment", "return_to", "expires_at")
    VALUES (${state}, ${input.userId}, ${input.environment}, ${input.returnTo ?? null},
            ${new Date(Date.now() + STATE_TTL_MS)})
  `
  // Housekeeping on the way past, so a table of dead states never builds up.
  await prisma.$executeRaw`DELETE FROM "bk_hmrc_oauth_states" WHERE "expires_at" < NOW()`
  return state
}

export type ConsumedState = {
  userId: string
  environment: HmrcEnvironment
  returnTo: string | null
}

/** Single use. A replayed state is no state at all. */
export async function consumeOauthState(state: string): Promise<ConsumedState | null> {
  const rows = await prisma.$queryRaw<
    { user_id: string; environment: HmrcEnvironment; return_to: string | null }[]
  >`
    DELETE FROM "bk_hmrc_oauth_states"
    WHERE "state" = ${state} AND "expires_at" > NOW()
    RETURNING "user_id", "environment", "return_to"
  `
  const row = rows[0]
  return row ? { userId: row.user_id, environment: row.environment, returnTo: row.return_to } : null
}
