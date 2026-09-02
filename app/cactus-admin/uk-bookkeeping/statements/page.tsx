import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import StatementsScreen from '@/modules/uk-bookkeeping/components/admin/StatementsScreen'

export const metadata = { title: 'Bank statements — Admin' }

// The page header lives inside the screen rather than here, because the button
// in it opens the import panel and needs the same state the list does.
export default async function BookkeepingStatementsPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see the bookkeeping.</div>
  }
  const settings = await getSettings()

  return <StatementsScreen environment={settings.hmrc_environment} canRecord={access.canRecord} />
}
