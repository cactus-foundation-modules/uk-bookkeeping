'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { ErrorNotice } from './Notices'
import { addStrings, poundsFromString, toDateInput, today } from './format'

// Recording one entry.
//
// Typing a gross amount back-solves net and VAT at the chosen rate, and the VAT
// stays editable so it can be made to match the supplier's own rounding penny
// for penny. A difference of more than a penny from the rate-implied figure
// WARNS and never blocks: the document is the record, not our arithmetic.

type Category = { id: string; name: string; direction: string; is_capital: boolean; archived: boolean }

type Line = {
  /** Client-side identity for React keys and input ids. Never sent to the server. */
  uid?: string
  categoryId: string
  description: string
  vatTreatment: string
  vatRateCode: string
  vatRatePercent: string
  netAmount: string
  vatAmount: string
  grossAmount: string
  isCapital: boolean
}

// Keys must survive a mid-list removal: keyed by index, deleting line two hands
// line three's focus and cursor to whatever now sits at index one.
let lineUidCounter = 0
const nextLineUid = () => {
  lineUidCounter += 1
  return `line-${lineUidCounter}`
}

const RATE_PERCENTS: Record<string, string> = {
  standard: '20.00',
  reduced: '5.00',
  zero: '0.00',
  exempt: '0.00',
  outside_scope: '0.00',
}

const RATE_LABELS: Record<string, string> = {
  standard: 'Standard rate (20%)',
  reduced: 'Reduced rate (5%)',
  zero: 'Zero rated',
  exempt: 'Exempt',
  outside_scope: 'Outside the scope of VAT',
}

const TREATMENT_LABELS: Record<string, string> = {
  domestic: 'UK domestic',
  ni_eu_acquisition: 'Goods bought into Northern Ireland from the EU',
  ni_eu_dispatch: 'Goods sold from Northern Ireland to the EU',
  reverse_charge_services: 'Services bought from overseas (reverse charge)',
  import_pva: 'Imported goods (postponed VAT accounting)',
  domestic_reverse_charge: 'UK reverse charge (e.g. construction)',
  outside_scope: 'Outside the scope of VAT',
}

const input: React.CSSProperties = {
  padding: '0.375rem 0.625rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  width: '100%',
}

const label: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-sm)',
  marginBottom: '0.25rem',
  color: 'var(--color-text-muted, var(--color-text))',
}

function emptyLine(category: Pick<Category, 'id' | 'is_capital'> | null): Line {
  return {
    uid: nextLineUid(),
    categoryId: category?.id ?? '',
    description: '',
    vatTreatment: 'domestic',
    vatRateCode: 'standard',
    vatRatePercent: RATE_PERCENTS.standard!,
    netAmount: '0.00',
    vatAmount: '0.00',
    grossAmount: '0.00',
    isCapital: category?.is_capital ?? false,
  }
}

/** Decimal arithmetic on strings, in pence, so no float ever exists here either. */
function pence(value: string): number {
  const cleaned = (value || '0').replace(/[^0-9.-]/g, '')
  const negative = cleaned.startsWith('-')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  const total = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0').slice(0, 2) || '0')
  return negative ? -total : total
}

function fromPence(value: number): string {
  const negative = value < 0
  const absolute = Math.abs(Math.round(value))
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

function vatForNet(net: string, ratePercent: string): string {
  return fromPence(Math.round((pence(net) * pence(ratePercent)) / 100 / 100))
}

function netForGross(gross: string, ratePercent: string): string {
  const rate = pence(ratePercent)
  return fromPence(Math.round((pence(gross) * 10000) / (rate + 10000)))
}

// No entry-level description. What an entry was for is asked once per line, in
// "What it was made up of", because that is the level it is actually true at: a
// receipt with a tank of fuel and a sandwich on it was for two things, and one
// box at the top can only ever hold one of them. The header text a list needs is
// worked out from the lines when the entry is saved.
export type TransactionFormValue = {
  id?: string
  entryType?: string
  direction: string
  taxPointDate: string
  settledDate: string
  counterparty: string
  reference: string
  correctsTransactionId?: string | null
  correctionReason?: string
  lines: Line[]
}

export default function TransactionForm({
  initial,
  correcting,
}: {
  initial?: TransactionFormValue
  correcting?: { id: string; counterparty: string; taxPointDate: string } | null
}) {
  const adminPath = useAdminPath()
  const [categories, setCategories] = useState<Category[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [knownCounterparties, setKnownCounterparties] = useState<string[]>([])
  // Once a human has chosen a category, the counterparty suggestion keeps its
  // hands off - a guess must never overwrite a decision.
  const [categoryTouched, setCategoryTouched] = useState(!!initial)

  const [value, setValue] = useState<TransactionFormValue>(() => {
    const base = initial ?? {
      entryType: correcting ? 'adjustment' : 'normal',
      direction: 'expense',
      taxPointDate: today(),
      settledDate: today(),
      counterparty: '',
      reference: '',
      correctsTransactionId: correcting?.id ?? null,
      correctionReason: '',
      lines: [emptyLine(null)],
    }
    return { ...base, lines: base.lines.map((line) => ({ ...line, uid: line.uid ?? nextLineUid() })) }
  })

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/categories')
      .then((r) => r.json())
      .then((data) => {
        const list: Category[] = data.categories ?? []
        setCategories(list)
        setValue((prev) =>
          prev.lines.some((line) => !line.categoryId)
            ? {
                ...prev,
                lines: prev.lines.map((line) =>
                  line.categoryId
                    ? line
                    : {
                        ...line,
                        categoryId: list[0]?.id ?? '',
                        // The capital flag rides with the category everywhere a
                        // category is chosen, defaults included - otherwise a
                        // default of "Equipment" records a non-capital line.
                        isCapital: list[0]?.is_capital ?? false,
                      },
                ),
              }
            : prev,
        )
      })
      .catch(() => setError('The category list could not be loaded.'))
  }, [])

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/transactions/suggest')
      .then((r) => (r.ok ? r.json() : { counterparties: [] }))
      .then((data) => setKnownCounterparties(data.counterparties ?? []))
      .catch(() => setKnownCounterparties([]))
  }, [])

  /**
   * When the counterparty is one this site has seen before, pre-pick the
   * category their entries usually get filed under. Suggestion only: it fills
   * the select, it never overrides a choice already made.
   */
  async function suggestCategory(counterparty: string) {
    if (categoryTouched || !counterparty.trim()) return
    try {
      const response = await fetch(
        `/api/m/uk-bookkeeping/admin/transactions/suggest?counterparty=${encodeURIComponent(counterparty.trim())}`,
      )
      if (!response.ok) return
      const data = await response.json()
      const category = categories.find((c) => c.id === data.categoryId)
      if (!category) return
      setValue((prev) => ({
        ...prev,
        lines: prev.lines.map((line) => ({
          ...line,
          categoryId: category.id,
          isCapital: category.is_capital,
        })),
      }))
    } catch {
      // A failed suggestion is no suggestion. Nothing to say.
    }
  }

  const totals = useMemo(
    () =>
      value.lines.reduce(
        (acc, line) => ({
          net: addStrings(acc.net, line.netAmount || '0.00'),
          vat: addStrings(acc.vat, line.vatAmount || '0.00'),
          gross: addStrings(acc.gross, line.grossAmount || '0.00'),
        }),
        { net: '0.00', vat: '0.00', gross: '0.00' },
      ),
    [value.lines],
  )

  function setLine(index: number, patch: Partial<Line>) {
    setValue((prev) => ({
      ...prev,
      lines: prev.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }))
  }

  function changeNet(index: number, net: string) {
    const line = value.lines[index]!
    const vat = vatForNet(net, line.vatRatePercent)
    setLine(index, { netAmount: net, vatAmount: vat, grossAmount: fromPence(pence(net) + pence(vat)) })
  }

  function changeGross(index: number, gross: string) {
    const line = value.lines[index]!
    const net = netForGross(gross, line.vatRatePercent)
    setLine(index, {
      grossAmount: gross,
      netAmount: net,
      vatAmount: fromPence(pence(gross) - pence(net)),
    })
  }

  function changeVat(index: number, vat: string) {
    const line = value.lines[index]!
    setLine(index, { vatAmount: vat, grossAmount: fromPence(pence(line.netAmount) + pence(vat)) })
  }

  function changeRate(index: number, rateCode: string) {
    const line = value.lines[index]!
    const percent = RATE_PERCENTS[rateCode] ?? '0.00'
    const vat = vatForNet(line.netAmount, percent)
    setLine(index, {
      vatRateCode: rateCode,
      vatRatePercent: percent,
      vatAmount: vat,
      grossAmount: fromPence(pence(line.netAmount) + pence(vat)),
    })
  }

  function vatWarning(line: Line): string | null {
    const implied = vatForNet(line.netAmount, line.vatRatePercent)
    return Math.abs(pence(implied) - pence(line.vatAmount)) > 1
      ? `At this rate the VAT would be ${poundsFromString(implied)}. That is fine if it is what the document says.`
      : null
  }

  async function save() {
    setSaving(true)
    setError(null)
    const body = {
      entryType: value.entryType ?? 'normal',
      direction: value.direction,
      taxPointDate: value.taxPointDate,
      settledDate: value.settledDate || null,
      counterparty: value.counterparty,
      reference: value.reference || null,
      correctsTransactionId: value.correctsTransactionId ?? null,
      correctionReason: value.correctionReason || null,
      lines: value.lines.map(({ uid: _uid, ...line }) => line),
    }

    try {
      const response = await fetch(
        value.id
          ? `/api/m/uk-bookkeeping/admin/transactions/${value.id}`
          : '/api/m/uk-bookkeeping/admin/transactions',
        {
          method: value.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That could not be saved.')
        setSaving(false)
        return
      }

      const saved = await response.json()
      window.location.href = `/${adminPath}/m/uk-bookkeeping/transactions/${saved.id}`
    } catch {
      // A dropped connection must not leave "Saving…" disabled forever with no
      // explanation - nothing typed has been lost, so say so.
      setError('The save did not reach the server. Check the connection and try again - everything typed is still here.')
      setSaving(false)
    }
  }

  return (
    <form
      style={{ maxWidth: 960 }}
      onSubmit={(e) => {
        e.preventDefault()
        if (!saving) save()
      }}
    >
      <ErrorNotice message={error} />

      {correcting && (
        <div
          className="card"
          style={{ padding: '0.875rem 1rem', marginBottom: '1rem', background: 'var(--color-surface)' }}
        >
          <strong>This is a correction</strong> to the entry for {correcting.counterparty} dated{' '}
          {correcting.taxPointDate}. It goes on the current open return, not on the one already filed
          - which is how HMRC expects a mistake on a past return to be put right.
        </div>
      )}

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          <div>
            <label style={label} htmlFor="bk-direction">Money in or out</label>
            <select
              id="bk-direction"
              style={input}
              value={value.direction}
              onChange={(e) => setValue({ ...value, direction: e.target.value })}
            >
              <option value="expense">Money out (an expense)</option>
              <option value="income">Money in (a sale)</option>
            </select>
          </div>
          <div>
            <label style={label} htmlFor="bk-date">Invoice or receipt date</label>
            <input
              id="bk-date"
              type="date"
              style={input}
              value={toDateInput(value.taxPointDate)}
              onChange={(e) => setValue({ ...value, taxPointDate: e.target.value })}
            />
          </div>
          <div>
            <label style={label} htmlFor="bk-settled">Date it was paid</label>
            <input
              id="bk-settled"
              type="date"
              style={input}
              value={toDateInput(value.settledDate)}
              onChange={(e) => setValue({ ...value, settledDate: e.target.value })}
            />
          </div>
          <div>
            <label style={label} htmlFor="bk-counterparty">Who it was with</label>
            <input
              id="bk-counterparty"
              style={input}
              value={value.counterparty}
              placeholder="Supplier or customer"
              list="bk-counterparty-suggestions"
              onChange={(e) => setValue({ ...value, counterparty: e.target.value })}
              onBlur={(e) => suggestCategory(e.target.value)}
            />
            <datalist id="bk-counterparty-suggestions">
              {knownCounterparties.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div>
            <label style={label} htmlFor="bk-reference">Their invoice number</label>
            <input
              id="bk-reference"
              style={input}
              value={value.reference}
              onChange={(e) => setValue({ ...value, reference: e.target.value })}
            />
          </div>
          {value.entryType === 'adjustment' && (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={label} htmlFor="bk-reason">Why this correction is needed</label>
              <input
                id="bk-reason"
                style={input}
                value={value.correctionReason ?? ''}
                onChange={(e) => setValue({ ...value, correctionReason: e.target.value })}
              />
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>What it was made up of</h3>
        <p style={{ margin: '0 0 1rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          One line is usually plenty. Add more when a single receipt covers more than one thing - a
          tank of fuel with a sandwich on it needs two, because they are taxed differently.
        </p>

        {value.lines.map((line, index) => (
          <div
            key={line.uid ?? index}
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: '0.875rem',
              marginBottom: '0.75rem',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label} htmlFor={`bk-line-${line.uid}-description`}>What it was for</label>
                <input
                  id={`bk-line-${line.uid}-description`}
                  style={input}
                  value={line.description}
                  placeholder={value.direction === 'income' ? 'What was sold' : 'What was bought'}
                  onChange={(e) => setLine(index, { description: e.target.value })}
                />
              </div>
              <div>
                <label style={label} htmlFor={`bk-line-${line.uid}-category`}>Category</label>
                <select
                  id={`bk-line-${line.uid}-category`}
                  style={input}
                  value={line.categoryId}
                  onChange={(e) => {
                    const category = categories.find((c) => c.id === e.target.value)
                    setCategoryTouched(true)
                    setLine(index, { categoryId: e.target.value, isCapital: category?.is_capital ?? false })
                  }}
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={label} htmlFor={`bk-line-${line.uid}-rate`}>VAT rate</label>
                <select
                  id={`bk-line-${line.uid}-rate`}
                  style={input}
                  value={line.vatRateCode}
                  onChange={(e) => changeRate(index, e.target.value)}
                >
                  {Object.entries(RATE_LABELS).map(([code, text]) => (
                    <option key={code} value={code}>
                      {text}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={label} htmlFor={`bk-line-${line.uid}-treatment`}>VAT treatment</label>
                <select
                  id={`bk-line-${line.uid}-treatment`}
                  style={input}
                  value={line.vatTreatment}
                  onChange={(e) => setLine(index, { vatTreatment: e.target.value })}
                >
                  {Object.entries(TREATMENT_LABELS).map(([code, text]) => (
                    <option key={code} value={code}>
                      {text}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={label} htmlFor={`bk-line-${line.uid}-gross`}>Total including VAT</label>
                <input
                  id={`bk-line-${line.uid}-gross`}
                  style={input}
                  inputMode="decimal"
                  value={line.grossAmount}
                  onChange={(e) => changeGross(index, e.target.value)}
                />
              </div>
              <div>
                <label style={label} htmlFor={`bk-line-${line.uid}-net`}>Before VAT</label>
                <input
                  id={`bk-line-${line.uid}-net`}
                  style={input}
                  inputMode="decimal"
                  value={line.netAmount}
                  onChange={(e) => changeNet(index, e.target.value)}
                />
              </div>
              <div>
                <label style={label} htmlFor={`bk-line-${line.uid}-vat`}>VAT</label>
                <input
                  id={`bk-line-${line.uid}-vat`}
                  style={input}
                  inputMode="decimal"
                  value={line.vatAmount}
                  onChange={(e) => changeVat(index, e.target.value)}
                />
              </div>
            </div>

            {vatWarning(line) && (
              <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-warning, var(--color-text))' }}>
                {vatWarning(line)}
              </p>
            )}

            {value.lines.length > 1 && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: '0.5rem' }}
                onClick={() =>
                  setValue({ ...value, lines: value.lines.filter((_, i) => i !== index) })
                }
              >
                Remove this line
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            setValue({ ...value, lines: [...value.lines, emptyLine(categories[0] ?? null)] })
          }
        >
          Add another line
        </button>

        <div
          style={{
            marginTop: '1rem',
            paddingTop: '0.75rem',
            borderTop: '1px solid var(--color-border)',
            display: 'flex',
            gap: '1.5rem',
            flexWrap: 'wrap',
          }}
        >
          <span>Before VAT: <strong>{poundsFromString(totals.net)}</strong></span>
          <span>VAT: <strong>{poundsFromString(totals.vat)}</strong></span>
          <span>Total: <strong>{poundsFromString(totals.gross)}</strong></span>
        </div>
      </div>

      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Saving…' : value.id ? 'Save changes' : 'Record this'}
      </button>
    </form>
  )
}
