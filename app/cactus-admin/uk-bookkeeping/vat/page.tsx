import { getSessionFromCookie } from '@/lib/auth/session'
import { getBookkeepingAccess } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { submissionHostForPage } from '@/modules/uk-bookkeeping/lib/hmrc/submission-host-page'
import LeaveSubmissionHost from '@/modules/uk-bookkeeping/components/admin/LeaveSubmissionHost'
import VatPeriodsScreen from '@/modules/uk-bookkeeping/components/admin/VatPeriodsScreen'

export const metadata = { title: 'VAT returns — Admin' }

export default async function VatPeriodsPage() {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getBookkeepingAccess(user)
  if (!access.canAccess) {
    return <div className="alert alert-danger">You do not have permission to see the bookkeeping.</div>
  }
  // VAT returns are filed from the direct hostname, where HMRC get every
  // detail they check for. See lib/hmrc/submission-host.ts.
  const leave = await submissionHostForPage('vat')
  const settings = await getSettings()

  return (
    <div>
      {leave && <LeaveSubmissionHost mainOrigin={leave.mainOrigin} stayPrefix={leave.stayPrefix} />}
      <div className="page-header">
        <h1 className="page-title">VAT returns</h1>
      </div>
      <VatPeriodsScreen environment={settings.hmrc_environment} canSubmit={access.canSubmit} />
    </div>
  )
}
