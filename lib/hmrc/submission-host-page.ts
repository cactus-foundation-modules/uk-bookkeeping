import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getAdminPathCached } from '@/lib/config/site'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { directHosts, onSubmissionHost, requestHostname, submissionHostFor } from './submission-host'

/** Where to send someone leaving the VAT screens on the direct hostname. */
export type LeaveSubmissionHost = {
  /** The main site's origin, e.g. https://example.co.uk. */
  mainOrigin: string
  /** Paths under here stay on the direct hostname; anything else goes back. */
  stayPrefix: string
}

/**
 * The VAT screens' host handling, both directions, in one call.
 *
 * Opened on the proxied address: redirect to the same screen on the direct
 * hostname, before anything that talks to HMRC loads. Opened on the direct
 * hostname: return what the screen needs to send the browser back to the main
 * address the moment it heads anywhere else, so the rest of the admin is used
 * where it normally is. A no-op (null) where the site has no direct hostname.
 * `subpath` is the screen under the module, e.g. `vat` or `vat/<id>`.
 */
export async function submissionHostForPage(subpath: string): Promise<LeaveSubmissionHost | null> {
  const requestHeaders = await headers()
  const adminPath = (await getAdminPathCached()) ?? 'cactus-admin'
  const host = submissionHostFor(requestHeaders)
  if (host) redirect(onSubmissionHost(host, `/${adminPath}/m/uk-bookkeeping/${subpath}`))

  if (!directHosts().includes(requestHostname(requestHeaders))) return null
  const siteUrl = getSiteUrlOrNull()
  if (!siteUrl) return null
  let mainOrigin: string
  try {
    mainOrigin = new URL(siteUrl).origin
  } catch {
    return null
  }
  return { mainOrigin, stayPrefix: `/${adminPath}/m/uk-bookkeeping/vat` }
}
