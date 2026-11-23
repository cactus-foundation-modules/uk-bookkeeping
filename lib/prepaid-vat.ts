import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { getInstalledManifests } from '@/lib/modules/live-status'

// VAT paid to suppliers up front that the books have not heard about yet.
//
// A supplier paid on a proforma before they invoice makes the payment the tax
// point, so its VAT belongs to the period the money left - but the entry only
// arrives here when the invoice is approved, often a period later. When the
// owner switches on `include_prepaid_vat`, the overview asks every module
// contributing to `uk-bookkeeping.prepaid-vat` for those payments in a date
// range and adds their VAT to the reclaim side of its ESTIMATE. The VAT return
// never reads this: what is filed is only ever what the books hold.
//
// A contributor is a server-only function taking `{ from, to }` (yyyy-mm-dd)
// and answering with rows of `{ ref, label, paidOn, vat }`, VAT in the site's
// currency, already net of anything it has handed to the books. Nothing here
// imports another module: the answer is checked against the schema below, and
// a contributor that throws or answers nonsense is logged and left out rather
// than taking the overview down.

export const PREPAID_VAT_POINT = 'uk-bookkeeping.prepaid-vat'

const Item = z.object({
  ref: z.string().min(1),
  label: z.string(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vat: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
})
const Answer = z.array(Item)

export type PrepaidVatItem = z.infer<typeof Item> & { source: string }

type ExtensionPointEntry = { point: string; id: string }
type Contributor = (range: { from: string; to: string }) => Promise<unknown> | unknown

/** Every contributor's paid-up-front orders with a payment date in the range. */
export async function collectPrepaidVat(from: string, to: string): Promise<PrepaidVatItem[]> {
  // Dynamic: the registry imports this module's own files, so a static import is a cycle.
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const fns = moduleServerExtensionPointComponents[PREPAID_VAT_POINT] ?? {}
  if (Object.keys(fns).length === 0) return []

  const items: PrepaidVatItem[] = []
  const modules = await getInstalledManifests()
  for (const mod of modules) {
    const manifest = mod.manifest as { extensionPoints?: ExtensionPointEntry[] } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point !== PREPAID_VAT_POINT) continue
      const fn = fns[entry.id] as Contributor | undefined
      if (typeof fn !== 'function') continue
      try {
        const parsed = Answer.safeParse(await fn({ from, to }))
        if (!parsed.success) {
          console.error(`[uk-bookkeeping] "${entry.id}" answered ${PREPAID_VAT_POINT} in a shape we cannot read:`, parsed.error.issues[0])
          continue
        }
        for (const item of parsed.data) items.push({ ...item, source: entry.id })
      } catch (error) {
        console.error(`[uk-bookkeeping] "${entry.id}" failed at ${PREPAID_VAT_POINT}:`, error)
      }
    }
  }
  return items
}

/** The VAT on a set of prepaid items, added up exactly. */
export function sumPrepaidVat(items: { vat: string }[]): Prisma.Decimal {
  return items.reduce((total, item) => total.plus(item.vat), new Prisma.Decimal(0))
}
