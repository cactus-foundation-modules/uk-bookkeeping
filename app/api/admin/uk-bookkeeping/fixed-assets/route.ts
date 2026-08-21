import { NextRequest, NextResponse } from 'next/server'
import { listAccounts } from '@/modules/uk-bookkeeping/lib/accounts'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  createFixedAsset,
  listAssetDrafts,
  listFixedAssets,
} from '@/modules/uk-bookkeeping/lib/fixed-assets'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// The fixed asset register. The accounts list rides along because the form
// needs it and a second request for a list of twenty rows is a round trip
// nobody gains anything from.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const params = request.nextUrl.searchParams

  try {
    // Drafts come back on their own list rather than mixed into the register.
    // They are not assets yet - nothing is depreciated on them and they claim
    // nothing - and a screen that showed them in the same table would be
    // saying they were, which is the misunderstanding that costs the tax.
    const [assets, drafts, accounts] = await Promise.all([
      listFixedAssets({
        includeDisposed: params.get('includeDisposed') !== 'false',
        includeArchived: params.get('includeArchived') === 'true',
      }),
      listAssetDrafts(),
      listAccounts(),
    ])
    return NextResponse.json({ assets, drafts, accounts })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ asset: await createFixedAsset(body, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
