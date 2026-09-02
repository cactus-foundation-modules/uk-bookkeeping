import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { getTransfer } from '@/modules/uk-bookkeeping/lib/transfers'
import { BookkeepingNav, SandboxBanner } from '@/modules/uk-bookkeeping/components/admin/Notices'
import TransactionForm from '@/modules/uk-bookkeeping/components/admin/TransactionForm'

export const metadata = { title: 'Transfer — Admin' }

// A transfer has no detail page of its own the way an entry does: there is no
// receipt to show, nothing to reconcile against it here, and no lines to read.
// What it has is the form that made it, filled in again.

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canRecord) {
    return <div className="alert alert-danger">You do not have permission to record entries.</div>
  }

  const { id } = await params
  const transfer = await getTransfer(id)
  if (!transfer) {
    return <div className="alert alert-danger">That transfer could not be found.</div>
  }

  const settings = await getSettings()

  return (
    <div>
      <BookkeepingNav active="transactions" />
      <SandboxBanner environment={settings.hmrc_environment} />
      <div className="page-header">
        <h1 className="page-title">Transfer between your own accounts</h1>
      </div>
      <TransactionForm
        initial={{
          id: transfer.id,
          direction: 'transfer',
          taxPointDate: transfer.date.toISOString().slice(0, 10),
          settledDate: '',
          bankAccountId: transfer.from_bank_account_id,
          transferToBankAccountId: transfer.to_bank_account_id,
          transferAmount: transfer.amount,
          counterparty: '',
          reference: transfer.reference ?? '',
          lines: [],
        }}
      />
    </div>
  )
}
