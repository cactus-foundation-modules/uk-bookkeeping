import { NextResponse } from 'next/server'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { callbackUrl, isHmrcConfigured } from '@/modules/uk-bookkeeping/lib/hmrc/endpoints'
import { disconnect, getConnection } from '@/modules/uk-bookkeeping/lib/hmrc/tokens'
import { listRecentApiCalls } from '@/modules/uk-bookkeeping/lib/hmrc/api-log'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const connection = await getConnection()
  const siteUrl = getSiteUrlOrNull()
  return NextResponse.json({
    configured: isHmrcConfigured(),
    status: connection.status,
    vrn: connection.vrn,
    environment: connection.environment,
    connectedAt: connection.connected_at,
    accessTokenExpiresAt: connection.access_token_expires_at,
    refreshTokenExpiresAt: connection.refresh_token_expires_at,
    lastRefreshError: connection.last_refresh_error,
    redirectUri: siteUrl ? callbackUrl(siteUrl) : null,
    recentCalls: await listRecentApiCalls(20),
  })
}

export async function DELETE() {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error
  await disconnect(gate.user)
  return NextResponse.json({ ok: true })
}
