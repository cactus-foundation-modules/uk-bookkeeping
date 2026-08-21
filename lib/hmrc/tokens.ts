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
 * PgBouncer runs in transaction pooling mode, so there is no session-level
 * advisory lock available to serialise two concurrent refreshes. Instead the
 * write is conditional on the `last_refresh_at` we read, and a loser simply
 * re-reads the row the winner just wrote. HMRC rotates the refresh token on
 * every use, so the loser must NOT go on to use the token it fetched with.
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

  const accessToken = tryDecryptSecret(connection.access_token_encrypted)
  const expiresAt = connection.access_token_expires_at?.getTime() ?? 0
  const stillGood = accessToken && expiresAt - Date.now() > REFRESH_MARGIN_MS
  if (stillGood) {
    return { accessToken, environment: connection.environment, vrn: connection.vrn }
  }

  const refreshToken = tryDecryptSecret(connection.refresh_token_encrypted)
  if (!refreshToken) {
    // Either there is no refresh token, or this install's ENCRYPTION_KEY cannot
    // read the one that is there - the restored-backup case. Both mean the same
    // thing to the owner, and it is a sentence rather than a stack trace.
    await markExpired('The stored HMRC connection cannot be read by this site.')
    throw new HmrcReauthRequiredError()
  }

  const seen = connection.last_refresh_at
  let tokens: HmrcTokens
  try {
    tokens = await client.refresh({ refreshToken, environment: connection.environment })
  } catch (error) {
    // Before declaring the connection dead, look again: HMRC's refresh tokens
    // are single-use, so the commonest "failure" is losing a race - another
    // request refreshed with this same token a moment ago and stored a
    // perfectly good replacement. That is not an expiry.
    const fresh = await getConnection()
    const winnerMoved =
      (fresh.last_refresh_at?.getTime() ?? 0) !== (seen?.getTime() ?? 0)
    if (winnerMoved) {
      const freshToken = tryDecryptSecret(fresh.access_token_encrypted)
      if (freshToken && (fresh.access_token_expires_at?.getTime() ?? 0) > Date.now()) {
        return { accessToken: freshToken, environment: fresh.environment, vrn: fresh.vrn }
      }
    }
    // A timeout or an HMRC outage is transient: the stored refresh token is
    // very likely still good, so surface the error without burning the
    // connection to 'expired' and marching the owner back through the
    // Government Gateway for nothing.
    if (
      error instanceof HmrcApiError &&
      (error.httpStatus >= 500 || error.httpStatus === 429)
    ) {
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

  // The comparison truncates BOTH sides to milliseconds. The column is a bare
  // TIMESTAMPTZ (microseconds); the value in hand round-tripped through a JS
  // Date (milliseconds). Compared raw they are almost never equal, which made
  // every refresh look like a lost race: the rotated token was thrown away, the
  // stale one returned, and the connection died at every expiry.
  const written = await prisma.$executeRaw`
    UPDATE "bk_hmrc_connection" SET
      "access_token_encrypted"   = ${encryptSecret(tokens.accessToken)},
      "access_token_expires_at"  = ${new Date(Date.now() + tokens.expiresIn * 1000)},
      "refresh_token_encrypted"  = ${encryptSecret(tokens.refreshToken)},
      "status"                   = 'connected',
      "last_refresh_at"          = NOW(),
      "last_refresh_error"       = NULL,
      "updated_at"               = NOW()
    WHERE "id" = 'singleton'
      AND (date_trunc('milliseconds', "last_refresh_at")
           IS NOT DISTINCT FROM date_trunc('milliseconds', ${seen}::timestamptz))
  `

  if (written === 0) {
    // Somebody else refreshed while we were away, and the token we just fetched
    // has already been superseded by theirs. Use what they stored.
    const fresh = await getConnection()
    const freshToken = tryDecryptSecret(fresh.access_token_encrypted)
    if (!freshToken) throw new HmrcReauthRequiredError()
    return { accessToken: freshToken, environment: fresh.environment, vrn: fresh.vrn }
  }

  return { accessToken: tokens.accessToken, environment: connection.environment, vrn: connection.vrn }
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
