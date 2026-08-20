import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { getSessionFromCookie } from '@/lib/auth/session'
import { getAdminPathCached } from '@/lib/config/site'
import { appendAudit } from '@/modules/uk-bookkeeping/lib/audit'
import { DirectHmrcClient } from '@/modules/uk-bookkeeping/lib/hmrc/direct-client'
import { isHmrcConfigured } from '@/modules/uk-bookkeeping/lib/hmrc/endpoints'
import { consumeOauthState, getConnection, storeTokens } from '@/modules/uk-bookkeeping/lib/hmrc/tokens'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'

// The OAuth redirect target, and the one URL on this whole module that has to be
// the same string on every install.
//
// It sits OUTSIDE the admin path on purpose. The admin path is per-install
// configurable, and HMRC needs an exact pre-registered redirect URI - so putting
// it in here would mean every install registered a different string, and
// renaming the admin path afterwards would break the connection with no warning.
//
// Not permission-gated, because HMRC is the caller and it holds no session. The
// protections are the single-use, ten-minute `state` created when the connection
// was started, and the check that the browser coming back is the same signed-in
// admin who started it.

function fail(reason: string, adminPath: string): NextResponse {
  const url = new URL(`${getSiteUrl()}/${adminPath}/config`)
  url.searchParams.set('tab', 'uk-bookkeeping')
  url.searchParams.set('hmrc', 'error')
  url.searchParams.set('reason', reason)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  // The admin path has to be looked up rather than read off the request: core
  // only stamps x-cactus-admin-path on admin PAGE rewrites, and this is an API
  // route, which never sees it. Which is the same reason the redirect URI itself
  // does not contain the admin path - see lib/hmrc/endpoints.ts.
  const adminPath = (await getAdminPathCached()) ?? 'cactus-admin'

  const query = request.nextUrl.searchParams
  const error = query.get('error')
  const code = query.get('code')
  const state = query.get('state')

  // The owner pressed "no" on the Government Gateway consent screen, which is
  // not a fault and should not read like one.
  if (error) {
    return fail(error === 'access_denied' ? 'declined' : 'refused', adminPath)
  }
  if (!code || !state) return fail('incomplete', adminPath)
  if (!isHmrcConfigured()) return fail('not-configured', adminPath)

  const consumed = await consumeOauthState(state)
  if (!consumed) return fail('expired', adminPath)

  const user = await getSessionFromCookie()
  if (!user || user.id !== consumed.userId) {
    return fail('different-user', adminPath)
  }

  try {
    const client = new DirectHmrcClient(getSiteUrl())
    const tokens = await client.exchangeCode({ code, environment: consumed.environment })

    const settings = await getSettings()
    const connection = await getConnection()
    await storeTokens({
      tokens,
      environment: consumed.environment,
      vrn: settings.vrn ?? connection.vrn,
      user,
    })

    await appendAudit({
      action: 'hmrc.connected',
      entityType: 'hmrc_connection',
      summary: `Connected to HMRC (${consumed.environment})`,
      detail: { environment: consumed.environment, scope: tokens.scope },
      user,
    })

    const destination = new URL(consumed.returnTo || `${getSiteUrl()}/${adminPath}/config`)
    destination.searchParams.set('tab', 'uk-bookkeeping')
    destination.searchParams.set('hmrc', 'connected')
    return NextResponse.redirect(destination)
  } catch {
    // Deliberately not surfacing HMRC's own message here: this lands in a URL
    // bar, and the settings panel says what to do about it in full.
    return fail('exchange-failed', adminPath)
  }
}
