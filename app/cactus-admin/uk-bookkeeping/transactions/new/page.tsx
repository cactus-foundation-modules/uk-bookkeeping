import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { getTransaction } from '@/modules/uk-bookkeeping/lib/transactions'
import { BookkeepingNav, SandboxBanner } from '@/modules/uk-bookkeeping/components/admin/Notices'
import TransactionForm from '@/modules/uk-bookkeeping/components/admin/TransactionForm'

export const metadata = { title: 'Record an entry — Admin' }

export default async function NewTransactionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canRecord) {
    return <div className="alert alert-danger">You do not have permission to record entries.</div>
  }

  const settings = await getSettings()
  const { correcting: correctingId } = await searchParams

  // Correcting a filed entry: the new one lands in the current open period and
  // points back at the locked original, which is how HMRC expects a mistake on a
  // past return to be put right.
  const original = correctingId ? await getTransaction(correctingId) : null

  return (
    <div>
      <BookkeepingNav active="transactions" />
      <SandboxBanner environment={settings.hmrc_environment} />
      <div className="page-header">
        <h1 className="page-title">{original ? 'Post a correction' : 'Record an entry'}</h1>
      </div>
      <TransactionForm
        correcting={
          original
            ? {
                id: original.id,
                counterparty: original.counterparty,
                taxPointDate: original.tax_point_date.toISOString().slice(0, 10),
              }
            : null
        }
      />
    </div>
  )
}
