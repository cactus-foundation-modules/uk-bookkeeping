'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { ErrorNotice } from './Notices'
import {
  addStrings,
  fromPence,
  netForGross,
  pence,
  poundsFromString,
  resplitAtRate,
  toDateInput,
  today,
  vatForNet,
} from './format'

// Recording one entry.
//
// Typing a gross amount back-solves net and VAT at the chosen rate, and the VAT
// stays editable so it can be made to match the supplier's own rounding penny
// for penny. A difference of more than a penny from the rate-implied figure
// WARNS and never blocks: the document is the record, not our arithmetic.

type Category = { id: string; name: string; direction: string; is_capital: boolean; archived: boolean }

type BankAccount = { id: string; name: string; kind: string; archived: boolean }

const BANK_KIND_LABELS: Record<string, string> = {
  bank: 'bank account',
  card: 'card',
  cash: 'cash or prepaid balance',
}

type Line = {
  /** Client-side identity for React keys and input ids. Never sent to the server. */
  uid?: string
  /**
   * Which figure on this line is the fact, and which two are worked out from
   * it. Client-side only, never sent.
   *
   * Changing the VAT rate has to hold one of the three still, and holding the
   * net was wrong for the commonest case in the module: an entry raised from a
   * bank line, where the gross IS the money that left the account. Putting that
   * line onto 20% used to leave the total at £24 when the bank said £20, which
   * is a receipt that disagrees with the statement it came from.
   *
   * So the last figure typed wins, and a line nobody has typed into - an
   * imported one, or one being edited - starts on the gross.
   */
  anchor?: 'net' | 'gross'
  categoryId: string
  description: string
  vatTreatment: string
  vatRateCode: string
  vatRatePercent: string
  netAmount: string
  vatAmount: string
  grossAmount: string
  isCapital: boolean
  /**
   * "Start an asset for this line." One per LINE, never one per entry: a
   * receipt for a desk and a chair is two assets with two lives, and a single
   * tick at the top of the form could not say which of them it meant.
   */
  registerAsset: boolean
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

const hint: React.CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text-muted, var(--color-text))',
}

function emptyLine(category: Pick<Category, 'id' | 'is_capital'> | null): Line {
  return {
    uid: nextLineUid(),
    anchor: 'gross',
    categoryId: category?.id ?? '',
    description: '',
    vatTreatment: 'domestic',
    vatRateCode: 'standard',
    vatRatePercent: RATE_PERCENTS.standard!,
    netAmount: '0.00',
    vatAmount: '0.00',
    grossAmount: '0.00',
    isCapital: category?.is_capital ?? false,
    // Ticked by default on a capital category, because that is what a capital
    // category MEANS: something the business will still have next year. The
    // ones that are not - a deposit, a stage payment - are the exception, and
    // the exception is the thing worth making somebody click.
    registerAsset: category?.is_capital ?? false,
  }
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
  /**
   * Which account the money moved through. Empty means the built-in main
   * current account, which is where every entry settled before this could be
   * asked - so an empty box changes nothing about how the books already read.
   *
   * It is only ever empty now on an entry saved before the question existed,
   * or on a site with no bank accounts set up at all. A new entry on a site
   * that has them starts on a real one, because the built-in account is not
   * in anybody's bank list and money stranded there shows up on the balance
   * sheet as cash the business does not have anywhere.
   *
   * The reason it can be asked at all: a balance held with a supplier - a
   * prepaid phone or postage account, a card topped up in advance - is a cash
   * account of the business like any other. Recording the top-up against it and
   * then each invoice as paid FROM it is what drains the balance down and keeps
   * the bank out of a payment the bank never made.
   */
  bankAccountId?: string
  /**
   * "There is no receipt for this one, and there is not meant to be." Keeps a
   * top-up onto a supplier balance, or a bank charge, off the list of things
   * still waiting for paperwork, where it would otherwise sit for six years.
   */
  evidenceNotRequired?: boolean
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
  // Whether this form is filling in a fresh entry or editing a saved one. The
  // two want different defaults, and the distinction is worth a name.
  const isNewEntry = !initial
  const [categories, setCategories] = useState<Category[]>([])
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([])
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
      // Blank, not today. A bill typed in is not a bill paid, and a date in
      // this box is the whole test for whether it settled: the ledger posts the
      // money side to a bank account, the balance sheet stops showing it as
      // owed, and it drops off "Who owes what". Defaulting to today made every
      // hand-typed purchase look paid the moment it was saved, and the only way
      // to record an unpaid one was to notice a pre-filled field and clear it.
      settledDate: '',
      bankAccountId: '',
      evidenceNotRequired: false,
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
                        registerAsset: list[0]?.is_capital ?? false,
                      },
                ),
              }
            : prev,
        )
      })
      .catch(() => setError('The category list could not be loaded.'))
  }, [])

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/bank-accounts')
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((data) => {
        const list: BankAccount[] = (data.accounts ?? []).filter((a: BankAccount) => !a.archived)
        setBankAccounts(list)
        // A new entry starts on the first real account rather than on a
        // placeholder. The placeholder settled the money against a built-in
        // "main current account" that is not in this list and that nobody
        // reconciles, so leaving the box alone stranded the payment there and
        // grew a bank line on the balance sheet for money that moved somewhere
        // else entirely.
        //
        // An entry being EDITED keeps whatever it was saved with, even if that
        // is nothing. Silently re-pointing somebody's history the moment they
        // opened it would be a good deal worse than the stray line.
        const first = list[0]
        if (isNewEntry && first) {
          setValue((prev) => (prev.bankAccountId ? prev : { ...prev, bankAccountId: first.id }))
        }
      })
      // Not an error worth a banner. The box simply does not appear, and the
      // entry settles where it always did.
      .catch(() => setBankAccounts([]))
  }, [isNewEntry])

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
          registerAsset: category.is_capital,
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
    setLine(index, {
      anchor: 'net',
      netAmount: net,
      vatAmount: vat,
      grossAmount: fromPence(pence(net) + pence(vat)),
    })
  }

  function changeGross(index: number, gross: string) {
    const line = value.lines[index]!
    const net = netForGross(gross, line.vatRatePercent)
    setLine(index, {
      anchor: 'gross',
      grossAmount: gross,
      netAmount: net,
      vatAmount: fromPence(pence(gross) - pence(net)),
    })
  }

  function changeVat(index: number, vat: string) {
    const line = value.lines[index]!
    setLine(index, { vatAmount: vat, grossAmount: fromPence(pence(line.netAmount) + pence(vat)) })
  }

  /**
   * Changing the rate re-splits the line, holding whichever figure was typed.
   *
   * Gross-anchored - which is every imported line and every receipt somebody
   * read the total off - the total stays put and the VAT comes OUT of it. Net
   * -anchored, the VAT goes on top. The old behaviour was always the second
   * one, so putting an imported £20 line onto 20% quietly made it £24.
   */
  function changeRate(index: number, rateCode: string) {
    const line = value.lines[index]!
    const percent = RATE_PERCENTS[rateCode] ?? '0.00'
    setLine(index, {
      vatRateCode: rateCode,
      vatRatePercent: percent,
      ...resplitAtRate(line, percent, line.anchor),
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
      bankAccountId: value.bankAccountId || null,
      evidenceNotRequired: !!value.evidenceNotRequired,
      counterparty: value.counterparty,
      reference: value.reference || null,
      correctsTransactionId: value.correctsTransactionId ?? null,
      correctionReason: value.correctionReason || null,
      lines: value.lines.map(({ uid: _uid, anchor: _anchor, ...line }) => line),
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
              aria-describedby="bk-settled-hint"
            />
            <p id="bk-settled-hint" style={hint}>
              Leave empty if it has not been paid yet. It will show under what is owed until you fill
              this in.
            </p>
          </div>
          {bankAccounts.length > 0 && (
            <div>
              <label style={label} htmlFor="bk-bank-account">
                {value.direction === 'income' ? 'Paid into' : 'Paid from'}
              </label>
              <select
                id="bk-bank-account"
                style={input}
                value={value.bankAccountId ?? ''}
                onChange={(e) => setValue({ ...value, bankAccountId: e.target.value })}
              >
                {/*
                  Only offered while nothing is chosen, which on a site with
                  bank accounts set up means an older entry saved before the
                  question was asked. It reads as the gap it is rather than as
                  a sensible default, and once a real account is picked it goes
                  away for good.
                */}
                {!value.bankAccountId && <option value="">Not recorded yet</option>}
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {BANK_KIND_LABELS[account.kind] ? ` (${BANK_KIND_LABELS[account.kind]})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
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

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.5rem',
            marginTop: '1rem',
            fontSize: 'var(--text-sm)',
          }}
        >
          <input
            type="checkbox"
            checked={!!value.evidenceNotRequired}
            onChange={(e) => setValue({ ...value, evidenceNotRequired: e.target.checked })}
            style={{ marginTop: '0.2rem' }}
          />
          <span>
            No receipt needed for this one
            <span
              style={{
                display: 'block',
                fontSize: 'var(--text-xs, 0.75rem)',
                color: 'var(--color-text-muted, var(--color-text))',
              }}
            >
              For the entries that are never going to have one - money put onto an account held
              with a supplier, a bank charge. It stops this entry counting as paperwork still
              owed, and nothing else.
            </span>
          </span>
        </label>
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
                    setLine(index, {
                      categoryId: e.target.value,
                      isCapital: category?.is_capital ?? false,
                      registerAsset: category?.is_capital ?? false,
                    })
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

            {/*
              Only on capital lines, and that is not tidiness. Everything on the
              asset register had its cost put on the balance sheet by a capital
              line; offering the tick on an ordinary cost would let someone put
              a desk in the P&L AND depreciate it, which counts it twice.
            */}
            {line.isCapital && (
              <label
                htmlFor={`bk-line-${line.uid}-asset`}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  margin: '0.75rem 0 0',
                  padding: '0.625rem 0.75rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  background: 'var(--color-bg)',
                  fontSize: 'var(--text-sm)',
                  lineHeight: 1.5,
                  cursor: 'pointer',
                }}
              >
                <input
                  id={`bk-line-${line.uid}-asset`}
                  type="checkbox"
                  checked={line.registerAsset}
                  onChange={(e) => setLine(index, { registerAsset: e.target.checked })}
                  style={{ marginTop: '0.2rem', flexShrink: 0 }}
                />
                <span>
                  <strong>Put this one on the asset register.</strong> It starts an entry for you to
                  finish off under Assets - how to spread the cost, and which tax allowances it
                  qualifies for. Leave it ticked unless this is a deposit or a part payment towards
                  something already on the register.
                </span>
              </label>
            )}

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
