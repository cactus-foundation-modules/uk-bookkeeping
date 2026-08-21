import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import FixedAssetsScreen from '@/modules/uk-bookkeeping/components/admin/FixedAssetsScreen'

export const metadata = { title: 'Equipment and assets — Admin' }

export default async function BookkeepingAssetsPage() {
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
        <h1 className="page-title">Equipment and assets</h1>
      </div>
      <FixedAssetsScreen environment={settings.hmrc_environment} canRecord={access.canRecord} />
    </div>
  )
}
