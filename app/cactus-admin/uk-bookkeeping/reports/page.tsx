import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import ReportsScreen from '@/modules/uk-bookkeeping/components/admin/ReportsScreen'

export const metadata = { title: 'Bookkeeping reports — Admin' }

export default async function BookkeepingReportsPage() {
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
        <h1 className="page-title">Reports</h1>
      </div>
      <ReportsScreen environment={settings.hmrc_environment} />
    </div>
  )
}
