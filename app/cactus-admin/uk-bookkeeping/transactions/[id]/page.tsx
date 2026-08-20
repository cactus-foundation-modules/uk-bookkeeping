import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import TransactionDetail from '@/modules/uk-bookkeeping/components/admin/TransactionDetail'

export const metadata = { title: 'Entry — Admin' }

export default async function TransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see the bookkeeping.</div>
  }

  const { id } = await params
  const settings = await getSettings()
  return <TransactionDetail id={id} environment={settings.hmrc_environment} canRecord={access.canRecord} />
}
