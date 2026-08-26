import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import DocumentsScreen from '@/modules/uk-bookkeeping/components/admin/DocumentsScreen'

export const metadata = { title: 'Receipts — Admin' }

export default async function DocumentsPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see the books.</div>
  }

  const settings = await getSettings()
  return <DocumentsScreen environment={settings.hmrc_environment} canRecord={access.canRecord} />
}
