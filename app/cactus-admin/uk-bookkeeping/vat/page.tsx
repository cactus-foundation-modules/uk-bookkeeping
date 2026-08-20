import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import VatPeriodsScreen from '@/modules/uk-bookkeeping/components/admin/VatPeriodsScreen'

export const metadata = { title: 'VAT returns — Admin' }

export default async function VatPeriodsPage() {
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
        <h1 className="page-title">VAT returns</h1>
      </div>
      <VatPeriodsScreen environment={settings.hmrc_environment} canSubmit={access.canSubmit} />
    </div>
  )
}
