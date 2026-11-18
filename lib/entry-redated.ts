import { getInstalledManifests } from '@/lib/modules/live-status'

// Telling the module an entry came from that its date has moved.
//
// An entry another module handed over (a supplier's approved invoice, say) keeps
// that module's own copy of the date. When the owner corrects the tax point here,
// because the VAT point was the day of payment and not the date typed off the
// invoice, the publisher's screens and reports go on showing the old one. So the
// change is published at `uk-bookkeeping.entry-redated` and whoever made the
// entry may listen. Nothing here imports another module, and nobody has to be
// listening: a site with no listener simply carries on.

export const ENTRY_REDATED_POINT = 'uk-bookkeeping.entry-redated'

export type EntryRedatedPayload = {
  /** The module that handed the entry over: `entry.source`. */
  source: string
  /** That module's own reference for it: `entry.source_ref`. */
  sourceRef: string
  /** yyyy-mm-dd, the tax point now. */
  taxPointDate: string
  /** yyyy-mm-dd, what it was before. */
  previousTaxPointDate: string
}

type ExtensionPointEntry = { point: string; id: string }
type Listener = (payload: EntryRedatedPayload) => Promise<unknown> | unknown

/**
 * Hands the change to every listener. A listener that throws is logged and
 * skipped: the owner has already corrected the entry, and somebody else's screen
 * being out of step must never undo that.
 */
export async function publishEntryRedated(payload: EntryRedatedPayload): Promise<void> {
  // Dynamic: the registry imports this module's own files, so a static import is a cycle.
  // The SERVER map, not the public one: a listener here writes to the database,
  // so its provider is rightly `serverOnly` and absent from the public map.
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const fns = moduleServerExtensionPointComponents[ENTRY_REDATED_POINT] ?? {}
  if (Object.keys(fns).length === 0) return
  const modules = await getInstalledManifests()
  for (const mod of modules) {
    const manifest = mod.manifest as { extensionPoints?: ExtensionPointEntry[] } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point !== ENTRY_REDATED_POINT) continue
      const fn = fns[entry.id] as Listener | undefined
      if (!fn) continue
      try {
        await fn(payload)
      } catch (error) {
        console.error(`[uk-bookkeeping] listener "${entry.id}" failed at ${ENTRY_REDATED_POINT}:`, error)
      }
    }
  }
}
