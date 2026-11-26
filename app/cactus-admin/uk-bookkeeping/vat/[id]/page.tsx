import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { submissionHostForPage } from '@/modules/uk-bookkeeping/lib/hmrc/submission-host-page'
import LeaveSubmissionHost from '@/modules/uk-bookkeeping/components/admin/LeaveSubmissionHost'
import VatReturnScreen from '@/modules/uk-bookkeeping/components/admin/VatReturnScreen'

export const metadata = { title: 'VAT return — Admin' }

export default async function VatReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see the bookkeeping.</div>
  }

  const { id } = await params
  // Filed from the direct hostname - see lib/hmrc/submission-host.ts.
  const leave = await submissionHostForPage(`vat/${encodeURIComponent(id)}`)
  const settings = await getSettings()
  return (
    <>
      {leave && <LeaveSubmissionHost mainOrigin={leave.mainOrigin} stayPrefix={leave.stayPrefix} />}
      <VatReturnScreen id={id} environment={settings.hmrc_environment} canSubmit={access.canSubmit} />
    </>
  )
}
