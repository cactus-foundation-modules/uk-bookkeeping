'use client'

import { useEffect } from 'react'

// On the direct hostname the VAT screens are the only reason to be there (see
// lib/hmrc/submission-host.ts). Anything else - the sidebar, the rest of the
// bookkeeping, a link in a notice, the back button - goes back to the main
// address, where everyone is already signed in.
//
// Clicks are caught in the capture phase, ahead of Next's own link handling, so
// an in-app navigation never quietly carries on on the wrong host. A click with
// a modifier (new tab and so on) is left alone, as is anything not on this
// origin. Renders nothing.

function isStay(pathname: string, stayPrefix: string): boolean {
  return pathname === stayPrefix || pathname.startsWith(`${stayPrefix}/`)
}

export default function LeaveSubmissionHost({
  mainOrigin,
  stayPrefix,
}: {
  mainOrigin: string
  stayPrefix: string
}) {
  useEffect(() => {
    function goBack(url: URL) {
      // A different origin, so a full page load - Next's router cannot cross hosts.
      window.location.href = new URL(`${url.pathname}${url.search}${url.hash}`, mainOrigin).toString()
    }

    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return
      let url: URL
      try {
        url = new URL(anchor.href, window.location.href)
      } catch {
        return
      }
      if (url.origin !== window.location.origin || isStay(url.pathname, stayPrefix)) return
      event.preventDefault()
      event.stopPropagation()
      goBack(url)
    }

    // Back and forward: the URL has already changed by the time this fires.
    function onPopState() {
      const url = new URL(window.location.href)
      if (!isStay(url.pathname, stayPrefix)) goBack(url)
    }

    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPopState)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('popstate', onPopState)
    }
  }, [mainOrigin, stayPrefix])

  return null
}
