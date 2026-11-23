import { beforeEach, describe, expect, it, vi } from 'vitest'

const points: Record<string, Record<string, unknown>> = {}
const manifests: { manifest: unknown }[] = []

vi.mock('@/lib/modules/extension-points.server', () => ({ moduleServerExtensionPointComponents: points }))
vi.mock('@/lib/modules/live-status', () => ({ getInstalledManifests: async () => manifests }))

import { collectPrepaidVat, PREPAID_VAT_POINT, sumPrepaidVat } from './prepaid-vat'

function install(id: string, fn: unknown) {
  points[PREPAID_VAT_POINT] = { ...(points[PREPAID_VAT_POINT] ?? {}), [id]: fn }
  manifests.push({ manifest: { extensionPoints: [{ point: PREPAID_VAT_POINT, id }] } })
}

describe('collectPrepaidVat', () => {
  beforeEach(() => {
    for (const key of Object.keys(points)) delete points[key]
    manifests.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('is empty when nothing contributes', async () => {
    expect(await collectPrepaidVat('2026-11-01', '2026-11-30')).toEqual([])
  })

  it('passes the range and tags each row with its contributor', async () => {
    const fn = vi.fn(async () => [{ ref: 'order:1', label: 'PO-1', paidOn: '2026-11-03', vat: '20.00' }])
    install('po', fn)
    const items = await collectPrepaidVat('2026-11-01', '2026-11-30')
    expect(fn).toHaveBeenCalledWith({ from: '2026-11-01', to: '2026-11-30' })
    expect(items).toEqual([{ ref: 'order:1', label: 'PO-1', paidOn: '2026-11-03', vat: '20.00', source: 'po' }])
  })

  it('leaves out a contributor that throws or answers in the wrong shape, keeping the rest', async () => {
    install('broken', async () => {
      throw new Error('nope')
    })
    install('nonsense', async () => [{ ref: 'x', label: 'x', paidOn: '3 Nov', vat: 'twenty' }])
    install('good', async () => [{ ref: 'order:2', label: 'PO-2', paidOn: '2026-11-04', vat: '5.5' }])
    const items = await collectPrepaidVat('2026-11-01', '2026-11-30')
    expect(items.map((item) => item.source)).toEqual(['good'])
  })

  it('adds up exactly, with no float drift', () => {
    const total = sumPrepaidVat([{ vat: '0.10' }, { vat: '0.20' }, { vat: '1234.56' }])
    expect(total.toFixed(2)).toBe('1234.86')
  })
})
