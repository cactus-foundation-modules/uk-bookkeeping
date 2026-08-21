import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import YearEndScreen from '@/modules/uk-bookkeeping/components/admin/YearEndScreen'

export const metadata = { title: 'Year end — Admin' }

export default async function BookkeepingYearEndPage() {
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
        <h1 className="page-title">Year end</h1>
      </div>
      <YearEndScreen
        environment={settings.hmrc_environment}
        canClose={access.canSubmit}
        canRecord={access.canRecord}
      />
    </div>
  )
}
