import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import CorporationTaxScreen from '@/modules/uk-bookkeeping/components/admin/CorporationTaxScreen'

export const metadata = { title: 'Corporation tax — Admin' }

export default async function BookkeepingCorporationTaxPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see the bookkeeping.</div>
  }
  const settings = await getSettings()

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Corporation tax</h1>
      </div>
      <CorporationTaxScreen
        environment={settings.hmrc_environment}
        canRecord={access.canRecord}
        canFinalise={access.canSubmit}
      />
    </div>
  )
}
