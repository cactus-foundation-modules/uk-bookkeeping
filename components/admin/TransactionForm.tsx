'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { useAdminConfirm } from '@/components/admin/useAdminConfirm'
import SearchableSelect from './SearchableSelect'
import DocumentPicker from './DocumentPicker'
import DropArea from './DropArea'
import EntryStyles from './EntryStyles'
import EvidenceDropzone, { type Attachment, readableSize, Thumb } from './EvidenceDropzone'
import { type UnfiledDocument } from './documents-shared'
import { ErrorNotice } from './Notices'
import { preflightFileError } from '@/modules/uk-bookkeeping/lib/file-kinds'
import {
  addStrings,
  formatDate,
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
   * The VAT box on this line has been opened for typing, to match a supplier's
   * own rounding. Client-side only, never sent. Typing an amount or changing the
   * rate closes it again, because the VAT is then worked out afresh.
   */
  vatEdit?: boolean
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
  standard: 'Standard 20%',
  reduced: 'Reduced 5%',
  zero: 'Zero rated 0%',
  exempt: 'Exempt',
  outside_scope: 'Outside scope',
}

/**
 * The treatments where the SUPPLIER charges nothing and the buyer accounts for
 * the VAT on both sides of their own return.
 *
 * These lines carry no VAT at all - zero is what was paid, and the total is what
 * left the bank, so the entry agrees with its statement line and the supplier is
 * shown owed what they invoiced. The notional VAT is worked out on the return
 * itself from the net and the rate, and lands in box 1 and box 4 together, where
 * it nets to nothing. Putting it on the line instead would make a £75 invoice a
 * £90 entry that no bank line can ever match.
 */
const BUYER_ACCOUNTS_FOR_VAT = ['reverse_charge_services', 'domestic_reverse_charge']

const TREATMENT_LABELS: Record<string, string> = {
  domestic: 'UK domestic',
  ni_eu_acquisition: 'Goods bought into Northern Ireland from the EU',
  ni_eu_dispatch: 'Goods sold from Northern Ireland to the EU',
  reverse_charge_services: 'Services bought from overseas (reverse charge)',
  import_pva: 'Imported goods (postponed VAT accounting)',
  domestic_reverse_charge: 'UK reverse charge (e.g. construction)',
  outside_scope: 'Outside the scope of VAT',
}

/**
 * Which of the three figures on every line is the one that gets typed, with the
 * other two worked out from it.
 *
 * One answer for the whole entry rather than one per line, because that is how a
 * person reads a document: either the paper shows a total including VAT (a till
 * receipt, a bank line) or it shows figures before VAT (an invoice to a trade
 * customer). Changing the VAT rate then holds the typed figure still, so a £20
 * bank line put onto 20% stays £20 and the VAT comes out of it, rather than
 * growing to £24.
 */
type EntryMode = 'gross' | 'net'

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
  /**
   * Only meaningful when direction is 'transfer'. A transfer has one amount
   * rather than lines, because there is nothing to split: no category, no VAT,
   * and no part of it that could be treated differently from the rest.
   */
  transferToBankAccountId?: string
  transferAmount?: string
  lines: Line[]
}

export default function TransactionForm({
  initial,
  correcting,
  initialDocumentId,
  attachments,
  onAttachmentsChange,
  onCancel,
}: {
  initial?: TransactionFormValue
  correcting?: { id: string; counterparty: string; taxPointDate: string } | null
  /**
   * A receipt already in the inbox that this entry is being written FROM -
   * "Record an entry" on the Receipts tab arrives here. The form fills itself in
   * from it and attaches it once the entry has an id to attach it to.
   */
  initialDocumentId?: string | null
  /** The receipts already on a saved entry that is being edited. */
  attachments?: Attachment[]
  onAttachmentsChange?: () => void
  /** Called by the Cancel button. Without it, Cancel goes back to the list. */
  onCancel?: () => void
}) {
  const adminPath = useAdminPath()
  const [askConfirm, confirmNode] = useAdminConfirm()
  // Whether this form is filling in a fresh entry or editing a saved one. The
  // two want different defaults, and the distinction is worth a name.
  const isNewEntry = !initial
  const [categories, setCategories] = useState<Category[]>([])
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [knownCounterparties, setKnownCounterparties] = useState<string[]>([])
  // Receipts picked out of the inbox while typing. Held rather than attached:
  // there is nothing to attach them TO until the entry has been saved and has an
  // id, and a link posted before then would file a receipt against nothing.
  const [chosenDocuments, setChosenDocuments] = useState<UnfiledDocument[]>([])
  // Files dropped on while typing, held in the browser for the same reason: the
  // upload route wants an entry id, and there isn't one until it is saved.
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [mode, setMode] = useState<EntryMode>('gross')
  // Set once a new entry has been saved but something after the save failed. A
  // second press of Save must then update THAT entry, not record a duplicate.
  const [savedId, setSavedId] = useState<string | null>(null)
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

  // A transfer between two of the business's own accounts. It writes a journal
  // rather than an entry - see lib/transfers.ts - so most of this form does not
  // apply to it, and the parts that do not are hidden rather than ignored.
  const isTransfer = value.direction === 'transfer'

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

  /**
   * Fill the form in from a receipt.
   *
   * Nothing already typed is overwritten. A blank box is a box nobody has
   * answered and a guess is welcome in it; a box with something in it is a
   * decision, and a document is not allowed to argue with one.
   *
   * The exception is the invoice date, which the document is simply better
   * placed to know than a form that defaulted to today - and which is the tax
   * point the VAT period is decided on.
   */
  function applyDocument(document: UnfiledDocument) {
    setChosenDocuments((prev) =>
      prev.some((held) => held.id === document.id) ? prev : [...prev, document],
    )
    // A document is read off its total, so that is the figure to hold still.
    if (document.guessed_total) setMode('gross')

    setValue((prev) => {
      const next: TransactionFormValue = { ...prev }
      if (isNewEntry && document.guessed_direction) next.direction = document.guessed_direction
      if (!prev.counterparty.trim() && document.guessed_counterparty) {
        next.counterparty = document.guessed_counterparty
      }
      if (document.guessed_document_date) next.taxPointDate = document.guessed_document_date
      if (!prev.reference.trim() && document.guessed_document_number) {
        next.reference = document.guessed_document_number
      }

      // Amounts only into a single line nobody has typed a figure into. A
      // receipt cannot sensibly be spread across a split that somebody has
      // already worked out by hand.
      const only = prev.lines.length === 1 ? prev.lines[0]! : null
      const total = document.guessed_total
      if (only && total && pence(only.grossAmount) === 0) {
        const net = document.guessed_net
        const vat = document.guessed_vat
        const impliedZero = vat !== null && vat !== undefined && pence(vat) === 0
        const rateCode = document.guessed_vat_rate_code ?? (impliedZero ? 'zero' : null)

        // A reverse charge: the whole payment is the net, the VAT box is nothing,
        // and the rate is the notional UK one the return works from.
        if (document.guessed_vat_treatment && BUYER_ACCOUNTS_FOR_VAT.includes(document.guessed_vat_treatment)) {
          const code = document.guessed_vat_rate_code ?? 'standard'
          next.lines = [
            {
              ...only,
              vatTreatment: document.guessed_vat_treatment,
              vatRateCode: code,
              vatRatePercent: RATE_PERCENTS[code] ?? '20.00',
              netAmount: total,
              vatAmount: '0.00',
              grossAmount: total,
            },
          ]
        } else if (net && vat && pence(net) + pence(vat) === pence(total)) {
          // The supplier's own split, exactly as printed. Their rounding is the
          // record; re-deriving it from a rate is a coin flip we do not need to
          // take when they have told us.
          const code = rateCode ?? only.vatRateCode
          next.lines = [
            {
              ...only,
              vatTreatment: document.guessed_vat_treatment ?? only.vatTreatment,
              vatRateCode: code,
              vatRatePercent: RATE_PERCENTS[code] ?? only.vatRatePercent,
              netAmount: net,
              vatAmount: vat,
              grossAmount: total,
            },
          ]
        } else {
          // A total and nothing else. Split it at whatever rate the document
          // implied, or at none, which is the honest reading of a document that
          // never mentioned VAT.
          const code = rateCode ?? 'zero'
          const percent = RATE_PERCENTS[code] ?? '0.00'
          const derived = netForGross(total, percent)
          next.lines = [
            {
              ...only,
              vatTreatment: document.guessed_vat_treatment ?? only.vatTreatment,
              vatRateCode: code,
              vatRatePercent: percent,
              netAmount: derived,
              vatAmount: fromPence(pence(total) - pence(derived)),
              grossAmount: total,
            },
          ]
        }
      }
      return next
    })

    if (document.guessed_counterparty) suggestCategory(document.guessed_counterparty)
  }

  // "Record an entry" on the Receipts tab lands here with one already chosen.
  useEffect(() => {
    if (!initialDocumentId) return
    let cancelled = false
    fetch(`/api/m/uk-bookkeeping/admin/documents/${initialDocumentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.document || data.document.transaction_id) return
        applyDocument(data.document)
      })
      .catch(() => {
        // The form still works without it; the receipt can be picked by hand.
      })
    return () => {
      cancelled = true
    }
    // Once, for the id it was given. applyDocument closes over state that moves
    // as the form is typed into, and re-running this on every keystroke would
    // undo what somebody had just changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDocumentId])

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
      vatEdit: false,
      netAmount: net,
      vatAmount: vat,
      grossAmount: fromPence(pence(net) + pence(vat)),
    })
  }

  function changeGross(index: number, gross: string) {
    const line = value.lines[index]!
    const net = netForGross(gross, line.vatRatePercent)
    setLine(index, {
      vatEdit: false,
      grossAmount: gross,
      netAmount: net,
      vatAmount: fromPence(pence(gross) - pence(net)),
    })
  }

  /**
   * Changing the treatment can change what the VAT box means.
   *
   * Moving a line onto a reverse charge zeroes it and hands the whole amount to
   * the net: nothing was charged. Moving it back off leaves the figures where
   * they are rather than inventing any - the rate is still there, and somebody
   * who wants the VAT can press the rate again.
   */
  function changeTreatment(index: number, treatment: string) {
    const line = value.lines[index]!
    if (!BUYER_ACCOUNTS_FOR_VAT.includes(treatment)) {
      setLine(index, { vatTreatment: treatment })
      return
    }
    const whole = mode === 'net' ? line.netAmount : line.grossAmount
    setLine(index, {
      vatEdit: false,
      vatTreatment: treatment,
      netAmount: whole,
      vatAmount: '0.00',
      grossAmount: whole,
    })
  }

  /**
   * The VAT typed over, to match the supplier's own rounding to the penny.
   *
   * It moves whichever figure is NOT the one being typed: entering including VAT,
   * the total is the fact and the net absorbs the difference; entering before
   * VAT, the net is the fact and the total follows.
   */
  function changeVat(index: number, vat: string) {
    const line = value.lines[index]!
    if (mode === 'gross') {
      setLine(index, {
        vatEdit: true,
        vatAmount: vat,
        netAmount: fromPence(pence(line.grossAmount) - pence(vat)),
      })
    } else {
      setLine(index, {
        vatEdit: true,
        vatAmount: vat,
        grossAmount: fromPence(pence(line.netAmount) + pence(vat)),
      })
    }
  }

  /**
   * Changing the rate re-splits the line, holding whichever figure is typed.
   *
   * Including VAT - which is every imported line and every receipt somebody read
   * the total off - the total stays put and the VAT comes OUT of it. Before VAT,
   * the VAT goes on top.
   */
  function changeRate(index: number, rateCode: string) {
    const line = value.lines[index]!
    const percent = RATE_PERCENTS[rateCode] ?? '0.00'
    // On a reverse charge the rate says what the VAT WOULD have been, and the
    // return works it out from there. Re-splitting the line at it would take VAT
    // out of a payment that never had any in it.
    if (BUYER_ACCOUNTS_FOR_VAT.includes(line.vatTreatment)) {
      setLine(index, { vatRateCode: rateCode, vatRatePercent: percent })
      return
    }
    setLine(index, {
      vatEdit: false,
      vatRateCode: rateCode,
      vatRatePercent: percent,
      ...resplitAtRate(line, percent, mode),
    })
  }

  function vatWarning(line: Line): string | null {
    if (BUYER_ACCOUNTS_FOR_VAT.includes(line.vatTreatment)) return null
    const implied = vatForNet(line.netAmount, line.vatRatePercent)
    return Math.abs(pence(implied) - pence(line.vatAmount)) > 1
      ? `At this rate the VAT would be ${poundsFromString(implied)}. That is fine if it is what the document says.`
      : null
  }

  /**
   * A transfer goes somewhere else entirely: it writes a journal rather than an
   * entry, so it has its own route, its own body, and no receipts to attach
   * afterwards. Kept as its own function rather than five branches inside the
   * one below, where the entry path would end up carrying checks that only ever
   * mean something for the other kind.
   */
  async function saveTransfer() {
    setSaving(true)
    setError(null)

    if (!value.bankAccountId || !value.transferToBankAccountId) {
      setError('A transfer needs an account it came out of and one it went into.')
      setSaving(false)
      return
    }

    try {
      const response = await fetch(
        value.id
          ? `/api/m/uk-bookkeeping/admin/transfers/${value.id}`
          : '/api/m/uk-bookkeeping/admin/transfers',
        {
          method: value.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: value.taxPointDate,
            amount: (value.transferAmount ?? '').trim(),
            fromBankAccountId: value.bankAccountId,
            toBankAccountId: value.transferToBankAccountId,
            reference: value.reference || null,
          }),
        },
      )

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That could not be saved.')
        setSaving(false)
        return
      }

      // No detail page of its own: a transfer is shown in the list of what
      // happened, alongside the entries, which is where somebody looking for it
      // would go.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- adminPath is resolved server-side, so the admin shell has to render it again
      window.location.href = `/${adminPath}/m/uk-bookkeeping/transactions?direction=transfer`
    } catch {
      setError('The save did not reach the server. Check the connection and try again - everything typed is still here.')
      setSaving(false)
    }
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
      // Their own paperwork is already on its way; a second invoice beside it
      // would be two documents for one payment.
      generateInvoice:
        chosenDocuments.length === 0 && pendingFiles.length === 0 && !value.evidenceNotRequired,
      counterparty: value.counterparty,
      reference: showReference ? value.reference || null : null,
      correctsTransactionId: value.correctsTransactionId ?? null,
      correctionReason: value.correctionReason || null,
      lines: value.lines.map(({ uid: _uid, vatEdit: _vatEdit, ...line }) => line),
    }

    try {
      const existingId = value.id ?? savedId
      const response = await fetch(
        existingId
          ? `/api/m/uk-bookkeeping/admin/transactions/${existingId}`
          : '/api/m/uk-bookkeeping/admin/transactions',
        {
          method: existingId ? 'PUT' : 'POST',
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
      setSavedId(saved.id)
      if (saved.invoiceError) {
        // Saved, but the invoice was not made. Staying on the form would invite
        // a second save and a duplicate entry, so say it and carry on to the
        // entry, where "Make the invoice" tries again under the same number.
        await askConfirm({
          title: 'The payment is saved',
          message: `Its invoice could not be made: ${saved.invoiceError}. There is a button on the entry to try again.`,
          confirmLabel: 'OK',
          cancelLabel: '',
          danger: false,
        })
      }

      // The receipts picked out of the inbox, wired to the entry now that it has
      // an id. One at a time and never fatally: the entry is saved, and a
      // receipt that would not attach is a thing to say, not a reason to leave
      // somebody staring at a form that appears not to have worked.
      const stubbornDocuments: UnfiledDocument[] = []
      for (const document of chosenDocuments) {
        try {
          const attached = await fetch(
            `/api/m/uk-bookkeeping/admin/documents/${document.id}/attach`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ transactionId: saved.id }),
            },
          )
          if (!attached.ok) stubbornDocuments.push(document)
        } catch {
          stubbornDocuments.push(document)
        }
      }
      // Files dropped onto the form go up the same way the saved entry's own
      // dropzone sends them, one at a time and never fatally.
      const stubbornFiles: File[] = []
      for (const file of pendingFiles) {
        try {
          const body = new FormData()
          body.append('file', file)
          body.append('name', file.name)
          const uploaded = await fetch(
            `/api/m/uk-bookkeeping/admin/transactions/${saved.id}/attachments`,
            { method: 'POST', body },
          )
          if (!uploaded.ok) stubbornFiles.push(file)
        } catch {
          stubbornFiles.push(file)
        }
      }
      // Whatever did not go stays held, so the next press of Save tries only
      // those and the ones that landed are not sent twice.
      setChosenDocuments(stubbornDocuments)
      setPendingFiles(stubbornFiles)
      const stubborn = [...stubbornDocuments.map((d) => d.name), ...stubbornFiles.map((f) => f.name)]
      if (stubborn.length > 0) {
        setError(
          `The entry is saved, but ${stubborn.join(' and ')} could not be attached to it. Press Save again to retry ${stubborn.length === 1 ? 'it' : 'them'}, or add ${stubborn.length === 1 ? 'it' : 'them'} from the entry itself.`,
        )
        setSaving(false)
        return
      }

      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- adminPath is resolved server-side, so the admin shell has to render it again
      window.location.href = `/${adminPath}/m/uk-bookkeeping/transactions/${saved.id}`
    } catch {
      // A dropped connection must not leave "Saving…" disabled forever with no
      // explanation - nothing typed has been lost, so say so.
      setError('The save did not reach the server. Check the connection and try again - everything typed is still here.')
      setSaving(false)
    }
  }

  const bankLabel = (account: BankAccount) =>
    `${account.name}${BANK_KIND_LABELS[account.kind] ? ` (${BANK_KIND_LABELS[account.kind]})` : ''}`

  // The VAT split by rate, for the summary. Only worth a breakdown when there is
  // more than one rate in play; a single rate IS the VAT line above it.
  const vatByRate = useMemo(() => {
    const groups = new Map<string, string>()
    for (const line of value.lines) {
      if (pence(line.vatAmount) === 0 && value.lines.length > 1) continue
      groups.set(line.vatRateCode, addStrings(groups.get(line.vatRateCode) ?? '0.00', line.vatAmount || '0.00'))
    }
    return [...groups.entries()]
  }, [value.lines])

  const paidFrom = bankAccounts.find((account) => account.id === value.bankAccountId)
  const cancelHref = `/${adminPath}/m/uk-bookkeeping/transactions`
  const submitLabel = saving
    ? 'Saving…'
    : value.id || savedId
      ? 'Save changes'
      : isTransfer
        ? 'Record this transfer'
        : 'Record this entry'
  const heldCount = chosenDocuments.length + pendingFiles.length

  function addFiles(files: File[]) {
    const accepted: File[] = []
    for (const file of files) {
      const reason = preflightFileError(file)
      if (reason) {
        setError(reason)
        continue
      }
      accepted.push(file)
    }
    if (accepted.length > 0) setPendingFiles((prev) => [...prev, ...accepted])
  }

  const settledValue = toDateInput(value.settledDate)
  // Money coming in gets OUR invoice number, handed out when the invoice is
  // made on save, so there is nothing to type. An older entry that already
  // carries a reference of the customer's keeps the box so it can be seen.
  const showReference = value.direction !== 'income' || !!value.id || !!value.reference.trim()

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (saving) return
        if (isTransfer) saveTransfer()
        else save()
      }}
    >
      <EntryStyles />
      {confirmNode}
      <ErrorNotice message={error} />

      <div className="bkx-layout">
        <div className="bkx-main">
          {correcting && (
            <div className="bkx-card" style={{ borderColor: 'var(--color-warning, var(--color-border))' }}>
              <strong>This is a correction</strong> to the entry for {correcting.counterparty} dated{' '}
              {correcting.taxPointDate}. It goes on the current open return, not on the one already
              filed - which is how HMRC expects a mistake on a past return to be put right.
            </div>
          )}

          <section className="bkx-card" aria-label="Details">
            <div className="bkx-card-head">
              <div className="bkx-seg" role="group" aria-label="Money in or out">
                {(
                  [
                    ['expense', 'Money out'],
                    ['income', 'Money in'],
                    ['transfer', 'Transfer'],
                  ] as const
                ).map(([code, text]) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={value.direction === code}
                    onClick={() => setValue({ ...value, direction: code })}
                  >
                    {text}
                  </button>
                ))}
              </div>
              {isTransfer && (
                <span className="bkx-tiny">
                  The same money, somewhere else. Touches nothing on the VAT return.
                </span>
              )}
            </div>

            {isTransfer ? (
              <div className="bkx-grid bkx-grid-2">
                <div className="bkx-field">
                  <label htmlFor="bk-date">Date it moved</label>
                  <input
                    id="bk-date"
                    type="date"
                    className="bkx-input"
                    value={toDateInput(value.taxPointDate)}
                    onChange={(e) => setValue({ ...value, taxPointDate: e.target.value })}
                  />
                </div>
                <div className="bkx-field">
                  <label htmlFor="bk-transfer-amount">How much moved</label>
                  <input
                    id="bk-transfer-amount"
                    className="bkx-input bkx-money"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={value.transferAmount ?? ''}
                    onChange={(e) => setValue({ ...value, transferAmount: e.target.value })}
                  />
                </div>
                <div className="bkx-field">
                  <label htmlFor="bk-bank-account">Out of</label>
                  <select
                    id="bk-bank-account"
                    className="bkx-input"
                    value={value.bankAccountId ?? ''}
                    onChange={(e) => setValue({ ...value, bankAccountId: e.target.value })}
                  >
                    {!value.bankAccountId && <option value="">Choose an account</option>}
                    {bankAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{bankLabel(account)}</option>
                    ))}
                  </select>
                </div>
                <div className="bkx-field">
                  <label htmlFor="bk-transfer-to">Into</label>
                  <select
                    id="bk-transfer-to"
                    className="bkx-input"
                    value={value.transferToBankAccountId ?? ''}
                    onChange={(e) => setValue({ ...value, transferToBankAccountId: e.target.value })}
                  >
                    <option value="">Choose an account</option>
                    {bankAccounts
                      // Never the account it came out of. Offering it would only
                      // ever produce a refusal from the server a moment later.
                      .filter((account) => account.id !== value.bankAccountId)
                      .map((account) => (
                        <option key={account.id} value={account.id}>{bankLabel(account)}</option>
                      ))}
                  </select>
                </div>
                <div className="bkx-field bkx-spanall">
                  <label htmlFor="bk-reference">Reference, if it had one</label>
                  <input
                    id="bk-reference"
                    className="bkx-input"
                    value={value.reference}
                    onChange={(e) => setValue({ ...value, reference: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <div className="bkx-grid">
                <div className={`bkx-field ${showReference ? 'bkx-span2' : 'bkx-spanall'}`}>
                  <label htmlFor="bk-counterparty">
                    {value.direction === 'income' ? 'Customer' : 'Supplier'}
                  </label>
                  <input
                    id="bk-counterparty"
                    className="bkx-input"
                    value={value.counterparty}
                    placeholder={value.direction === 'income' ? 'Who paid you' : 'Who you paid'}
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
                {showReference && (
                  <div className="bkx-field">
                    <label htmlFor="bk-reference">
                      {value.direction === 'income' ? 'Their reference' : 'Their invoice number'}
                    </label>
                    <input
                      id="bk-reference"
                      className="bkx-input"
                      value={value.reference}
                      onChange={(e) => setValue({ ...value, reference: e.target.value })}
                    />
                  </div>
                )}
                <div className="bkx-field">
                  <label htmlFor="bk-date">Invoice date</label>
                  <input
                    id="bk-date"
                    type="date"
                    className="bkx-input"
                    value={toDateInput(value.taxPointDate)}
                    onChange={(e) => setValue({ ...value, taxPointDate: e.target.value })}
                  />
                </div>
                <div className={`bkx-field${bankAccounts.length > 0 ? '' : ' bkx-span2'}`}>
                  <label htmlFor="bk-settled">
                    Date paid{' '}
                    {settledValue ? (
                      <button
                        type="button"
                        className="bkx-linkbtn"
                        onClick={() => setValue({ ...value, settledDate: '' })}
                      >
                        not paid yet
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="bkx-linkbtn"
                        onClick={() => setValue({ ...value, settledDate: today() })}
                      >
                        today
                      </button>
                    )}
                  </label>
                  <input
                    id="bk-settled"
                    type="date"
                    className="bkx-input"
                    value={settledValue}
                    onChange={(e) => setValue({ ...value, settledDate: e.target.value })}
                    aria-describedby="bk-settled-hint"
                  />
                  <div id="bk-settled-hint" className="bkx-tiny" style={{ marginTop: '0.25rem' }}>
                    {settledValue ? 'Paid.' : 'Blank means unpaid - it shows under what is owed.'}
                  </div>
                </div>
                {bankAccounts.length > 0 && (
                  <div className="bkx-field">
                    <label htmlFor="bk-bank-account">
                      {value.direction === 'income' ? 'Paid into' : 'Paid from'}
                    </label>
                    <select
                      id="bk-bank-account"
                      className="bkx-input"
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
                        <option key={account.id} value={account.id}>{bankLabel(account)}</option>
                      ))}
                    </select>
                  </div>
                )}
                {value.entryType === 'adjustment' && (
                  <div className="bkx-field bkx-spanall">
                    <label htmlFor="bk-reason">Why this correction is needed</label>
                    <input
                      id="bk-reason"
                      className="bkx-input"
                      value={value.correctionReason ?? ''}
                      onChange={(e) => setValue({ ...value, correctionReason: e.target.value })}
                    />
                  </div>
                )}
              </div>
            )}
          </section>

          {/*
            No lines on a transfer. There is nothing to split it into: no category,
            no VAT rate, and no part of it that could be treated differently from the
            rest. One amount, two accounts, and that is the whole of it.
          */}
          {!isTransfer && (
            <section className="bkx-card" aria-label="Line items">
              <div className="bkx-card-head">
                <h2 className="bkx-title">What it was for</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span className="bkx-tiny">I am typing amounts</span>
                  <div className="bkx-seg" role="group" aria-label="Which amount you type">
                    <button type="button" aria-pressed={mode === 'gross'} onClick={() => setMode('gross')}>
                      Including VAT
                    </button>
                    <button type="button" aria-pressed={mode === 'net'} onClick={() => setMode('net')}>
                      Before VAT
                    </button>
                  </div>
                </div>
              </div>

              <div className="bkx-lines-head" aria-hidden="true">
                <span>Description</span>
                <span>Category</span>
                <span>VAT rate</span>
                <span className="bkx-r">Before VAT</span>
                <span className="bkx-r">VAT</span>
                <span className="bkx-r">Total</span>
              </div>

              {value.lines.map((line, index) => {
                const buyerAccounts = BUYER_ACCOUNTS_FOR_VAT.includes(line.vatTreatment)
                const warning = vatWarning(line)
                return (
                  <div key={line.uid ?? index} className="bkx-line">
                    <div className="bkx-line-row">
                      <div className="bkx-c-desc">
                        <span className="bkx-cell-label">Description</span>
                        <input
                          id={`bk-line-${line.uid}-description`}
                          className="bkx-input"
                          aria-label="What it was for"
                          value={line.description}
                          placeholder={value.direction === 'income' ? 'What was sold' : 'What was bought'}
                          onChange={(e) => setLine(index, { description: e.target.value })}
                        />
                      </div>
                      <div>
                        <span className="bkx-cell-label">Category</span>
                        <SearchableSelect
                          id={`bk-line-${line.uid}-category`}
                          aria-label="Category"
                          style={{
                            width: '100%',
                            minHeight: '2.25rem',
                            padding: '0.375rem 0.625rem',
                            border: '1px solid var(--color-border)',
                            borderRadius: 8,
                            background: 'var(--color-bg)',
                            color: 'var(--color-text)',
                          }}
                          value={line.categoryId}
                          options={categories.map((category) => ({ value: category.id, label: category.name }))}
                          onChange={(categoryId) => {
                            const category = categories.find((c) => c.id === categoryId)
                            setCategoryTouched(true)
                            setLine(index, {
                              categoryId,
                              isCapital: category?.is_capital ?? false,
                              registerAsset: category?.is_capital ?? false,
                            })
                          }}
                        />
                      </div>
                      <div>
                        <span className="bkx-cell-label">VAT rate</span>
                        <select
                          id={`bk-line-${line.uid}-rate`}
                          className="bkx-input"
                          aria-label="VAT rate"
                          value={line.vatRateCode}
                          onChange={(e) => changeRate(index, e.target.value)}
                        >
                          {Object.entries(RATE_LABELS).map(([code, text]) => (
                            <option key={code} value={code}>{text}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <span className="bkx-cell-label">Before VAT</span>
                        {mode === 'net' || buyerAccounts ? (
                          <input
                            id={`bk-line-${line.uid}-net`}
                            className="bkx-input bkx-money"
                            aria-label="Before VAT"
                            inputMode="decimal"
                            value={line.netAmount}
                            onChange={(e) =>
                              buyerAccounts
                                ? setLine(index, { netAmount: e.target.value, grossAmount: e.target.value })
                                : changeNet(index, e.target.value)
                            }
                          />
                        ) : (
                          <output className="bkx-derived" aria-label="Before VAT">
                            {poundsFromString(line.netAmount)}
                          </output>
                        )}
                      </div>
                      <div>
                        <span className="bkx-cell-label">VAT</span>
                        {line.vatEdit && !buyerAccounts ? (
                          <input
                            id={`bk-line-${line.uid}-vat`}
                            className="bkx-input bkx-money"
                            aria-label="VAT"
                            inputMode="decimal"
                            value={line.vatAmount}
                            onChange={(e) => changeVat(index, e.target.value)}
                          />
                        ) : (
                          <output className="bkx-derived" aria-label="VAT">
                            {!buyerAccounts && (
                              <button
                                type="button"
                                title="Type the VAT yourself, to match the supplier's rounding"
                                onClick={() => setLine(index, { vatEdit: true })}
                              >
                                edit
                              </button>
                            )}
                            {poundsFromString(line.vatAmount)}
                          </output>
                        )}
                      </div>
                      <div>
                        <span className="bkx-cell-label">Total</span>
                        {mode === 'gross' && !buyerAccounts ? (
                          <input
                            id={`bk-line-${line.uid}-gross`}
                            className="bkx-input bkx-money"
                            aria-label="Total including VAT"
                            inputMode="decimal"
                            value={line.grossAmount}
                            onChange={(e) => changeGross(index, e.target.value)}
                          />
                        ) : (
                          <output className="bkx-derived" aria-label="Total including VAT">
                            {poundsFromString(line.grossAmount)}
                          </output>
                        )}
                      </div>
                    </div>

                    <div className="bkx-line-foot">
                      <label>
                        VAT treatment
                        <select
                          aria-label="VAT treatment"
                          value={line.vatTreatment}
                          onChange={(e) => changeTreatment(index, e.target.value)}
                        >
                          {Object.entries(TREATMENT_LABELS).map(([code, text]) => (
                            <option key={code} value={code}>{text}</option>
                          ))}
                        </select>
                      </label>
                      {/*
                        Only on capital lines, and that is not tidiness. Everything on
                        the asset register had its cost put on the balance sheet by a
                        capital line; offering the tick on an ordinary cost would let
                        someone put a desk in the P&L AND depreciate it, which counts
                        it twice.
                      */}
                      {line.isCapital && (
                        <label
                          htmlFor={`bk-line-${line.uid}-asset`}
                          title="Starts an entry under Assets to finish off: how to spread the cost, and which allowances it qualifies for. Leave it ticked unless this is a deposit or part payment towards something already registered."
                        >
                          <input
                            id={`bk-line-${line.uid}-asset`}
                            type="checkbox"
                            checked={line.registerAsset}
                            onChange={(e) => setLine(index, { registerAsset: e.target.checked })}
                          />
                          Put on the asset register
                        </label>
                      )}
                      {line.vatEdit && !buyerAccounts && (
                        <button type="button" className="bkx-linkbtn" onClick={() => changeRate(index, line.vatRateCode)}>
                          work the VAT out again
                        </button>
                      )}
                      {warning && <span className="bkx-warn">{warning}</span>}
                      {value.lines.length > 1 && (
                        <button
                          type="button"
                          className="bkx-linkbtn bkx-spacer"
                          onClick={() =>
                            setValue({ ...value, lines: value.lines.filter((_, i) => i !== index) })
                          }
                        >
                          Remove line
                        </button>
                      )}
                    </div>

                    {buyerAccounts && (
                      <p className="bkx-tiny" style={{ margin: '0.375rem 0 0' }}>
                        Your supplier charges no VAT here and you account for it yourself, so the
                        total is what you paid. The VAT goes on your return twice - owed and
                        reclaimed - and costs nothing. The rate is what it WOULD have been in the
                        UK, and the sum is worked out from it.
                      </p>
                    )}
                  </div>
                )
              })}

              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: '0.25rem' }}
                onClick={() =>
                  setValue({ ...value, lines: [...value.lines, emptyLine(categories[0] ?? null)] })
                }
              >
                + Add another line
              </button>
              {value.lines.length === 1 && (
                <span className="bkx-tiny" style={{ marginLeft: '0.75rem' }}>
                  One receipt, two rates - fuel and a sandwich, say - needs a line each.
                </span>
              )}
            </section>
          )}
        </div>

        <aside className="bkx-side" aria-label="Totals and receipts">
          <section className="bkx-card" aria-label="Summary">
            <div className="bkx-card-head">
              <h2 className="bkx-title">Summary</h2>
            </div>
            {isTransfer ? (
              <dl className="bkx-sum">
                <div className="bkx-sum-total">
                  <dt>Moving</dt>
                  <dd className="bkx-big" style={{ margin: 0 }}>
                    {poundsFromString((value.transferAmount ?? '').trim() || '0.00')}
                  </dd>
                </div>
              </dl>
            ) : (
              <dl className="bkx-sum">
                <div className="bkx-sum-row">
                  <dt>Before VAT</dt>
                  <dd>{poundsFromString(totals.net)}</dd>
                </div>
                <div className="bkx-sum-row">
                  <dt>VAT</dt>
                  <dd>{poundsFromString(totals.vat)}</dd>
                </div>
                {vatByRate.length > 1 &&
                  vatByRate.map(([code, vat]) => (
                    <div key={code} className="bkx-sum-row bkx-sub">
                      <dt>{RATE_LABELS[code] ?? code}</dt>
                      <dd>{poundsFromString(vat)}</dd>
                    </div>
                  ))}
                <div className="bkx-sum-total">
                  <dt>Total</dt>
                  <dd className="bkx-big" style={{ margin: 0 }}>{poundsFromString(totals.gross)}</dd>
                </div>
                <div className="bkx-tiny">
                  {settledValue
                    ? `Paid ${formatDate(settledValue)}${paidFrom ? ` ${value.direction === 'income' ? 'into' : 'from'} ${paidFrom.name}` : ''}.`
                    : 'Not paid yet - it will show under what is owed.'}
                </div>
              </dl>
            )}
            <div className="bkx-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {submitLabel}
              </button>
              {onCancel ? (
                <button type="button" className="btn" onClick={onCancel} disabled={saving}>
                  Cancel
                </button>
              ) : (
                <a className="btn" href={cancelHref} style={{ textDecoration: 'none' }}>
                  Cancel
                </a>
              )}
            </div>
          </section>

          {!isTransfer && (
            <section className="bkx-card" aria-label="Receipts">
              <div className="bkx-card-head">
                <h2 className="bkx-title">Receipts</h2>
                {heldCount > 0 && <span className="bkx-tiny">Attached when you save</span>}
              </div>

              {value.id && attachments ? (
                // An entry that already exists has somewhere to put a receipt, so
                // they go straight on, with no holding back.
                <EvidenceDropzone
                  transactionId={value.id}
                  attachments={attachments}
                  locked={false}
                  canRecord
                  onChange={onAttachmentsChange ?? (() => undefined)}
                />
              ) : (
                <>
                  {heldCount > 0 && (
                    <ul className="bkx-files">
                      {chosenDocuments.map((document) => (
                        <li key={document.id} className="bkx-file">
                          <Thumb mime={document.mime_type} id={document.id} />
                          <span className="bkx-file-body">
                            <a
                              href={`/api/m/uk-bookkeeping/admin/attachments/${document.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={document.name}
                            >
                              {document.name}
                            </a>
                            <span className="bkx-tiny">From the receipts inbox</span>
                          </span>
                          {!saving && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() =>
                                setChosenDocuments((prev) => prev.filter((held) => held.id !== document.id))
                              }
                            >
                              Take off
                            </button>
                          )}
                        </li>
                      ))}
                      {pendingFiles.map((file, index) => (
                        <li key={`${file.name}-${file.size}-${index}`} className="bkx-file">
                          <Thumb mime={file.type} />
                          <span className="bkx-file-body">
                            <span className="bkx-file-name" title={file.name}>{file.name}</span>
                            <span className="bkx-tiny">{readableSize(file.size)}</span>
                          </span>
                          {!saving && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== index))}
                            >
                              Take off
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <DropArea onFiles={addFiles} disabled={saving} compact={heldCount > 0} />
                  <DocumentPicker
                    plain
                    chosen={chosenDocuments}
                    onChoose={applyDocument}
                    onRelease={(id) =>
                      setChosenDocuments((prev) => prev.filter((document) => document.id !== id))
                    }
                    disabled={saving}
                  />
                </>
              )}

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  marginTop: '0.875rem',
                  fontSize: 'var(--text-sm)',
                  cursor: 'pointer',
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
                  <span className="bkx-tiny" style={{ display: 'block' }}>
                    For entries that never have one - a top-up onto a supplier balance, a bank
                    charge. Stops it counting as paperwork still owed.
                  </span>
                </span>
              </label>
            </section>
          )}
        </aside>
      </div>
    </form>
  )
}
