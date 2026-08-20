import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { DirectHmrcClient } from '@/modules/uk-bookkeeping/lib/hmrc/direct-client'
import { isHmrcConfigured } from '@/modules/uk-bookkeeping/lib/hmrc/endpoints'
import { createOauthState } from '@/modules/uk-bookkeeping/lib/hmrc/tokens'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'

// Start the authorisation. Returns the Government Gateway URL rather than
// redirecting, so the browser can open it itself and the admin's own page state
// survives the round trip.
export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  if (!isHmrcConfigured()) {
    return NextResponse.json(
      {
        error:
          'This site has no HMRC credentials yet. Add HMRC_CLIENT_ID and HMRC_CLIENT_SECRET to your hosting environment variables, then redeploy.',
        code: 'hmrc_not_configured',
      },
      { status: 503 },
    )
  }

  const body = await request.json().catch(() => ({}) as Record<string, unknown>)
  const settings = await getSettings()
  const environment = settings.hmrc_environment

  try {
    const state = await createOauthState({
      userId: gate.user.id,
      environment,
      returnTo: typeof body.returnTo === 'string' ? body.returnTo : null,
    })
    const client = new DirectHmrcClient(getSiteUrl())
    return NextResponse.json({ url: client.authorizationUrl({ state, environment }), environment })
  } catch (error) {
    return toErrorResponse(error)
  }
}
