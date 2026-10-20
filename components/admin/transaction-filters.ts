// The entries screen's filters, as plain data.
//
// Kept out of the component so the rules - what a preset means, how a filter
// becomes a query string, what a chip says - are one place that can be read,
// and so the screen file is only the screen. Nothing here touches the DOM
// except readFiltersFromUrl, which is only ever called from an effect.

export type Filters = {
  from: string
  to: string
  direction: '' | 'income' | 'expense' | 'transfer'
  search: string
  counterparty: string
  status: '' | 'posted' | 'draft'
  locked: '' | '1' | '0'
  /** One box, two server filters underneath: '1' has one, '0' still needs one, 'x' none needed. */
  evidence: '' | '1' | '0' | 'x'
  /** Matched to a bank statement line: '1' yes, '0' not yet. */
  reconciled: '' | '1' | '0'
  categoryId: string
  vatRateCode: string
  bankAccountId: string
  minAmount: string
  maxAmount: string
}

export type SortKey = 'date' | 'who' | 'amount'

export const EMPTY_FILTERS: Filters = {
  from: '',
  to: '',
  direction: '',
  search: '',
  counterparty: '',
  status: '',
  locked: '',
  evidence: '',
  reconciled: '',
  categoryId: '',
  vatRateCode: '',
  bankAccountId: '',
  minAmount: '',
  maxAmount: '',
}

export const VAT_RATE_LABELS: Record<string, string> = {
  standard: 'Standard rate',
  reduced: 'Reduced rate',
  zero: 'Zero rate',
  exempt: 'Exempt',
  outside_scope: 'Outside the scope of VAT',
}

// ---------------------------------------------------------------------------
// Date presets
// ---------------------------------------------------------------------------

function iso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export type DatePreset = { key: string; label: string; from: string; to: string }

/**
 * The ranges a bookkeeper reaches for. Calendar quarters rather than VAT
 * quarters: a business's VAT stagger is its own, and the VAT screen knows it;
 * this is only a shortcut for "roughly then". The tax year runs 6 April to 5
 * April, which is the one date in this file that is not negotiable.
 */
export function datePresets(today: Date = new Date()): DatePreset[] {
  const y = today.getFullYear()
  const m = today.getMonth()
  const quarterStart = new Date(y, m - (m % 3), 1)
  const taxYearStartYear = today >= new Date(y, 3, 6) ? y : y - 1
  const yearAgo = new Date(y - 1, m, today.getDate() + 1)
  return [
    { key: 'month', label: 'This month', from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    { key: 'last-month', label: 'Last month', from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    { key: 'quarter', label: 'This quarter', from: iso(quarterStart), to: iso(new Date(y, quarterStart.getMonth() + 3, 0)) },
    {
      key: 'tax-year',
      label: 'This tax year',
      from: iso(new Date(taxYearStartYear, 3, 6)),
      to: iso(new Date(taxYearStartYear + 1, 3, 5)),
    },
    {
      key: 'last-tax-year',
      label: 'Last tax year',
      from: iso(new Date(taxYearStartYear - 1, 3, 6)),
      to: iso(new Date(taxYearStartYear, 3, 5)),
    },
    { key: '12m', label: 'Last 12 months', from: iso(yearAgo), to: iso(today) },
  ]
}

export function activePresetKey(filters: Filters, presets: DatePreset[]): string {
  if (!filters.from && !filters.to) return 'all'
  return presets.find((p) => p.from === filters.from && p.to === filters.to)?.key ?? 'custom'
}

// ---------------------------------------------------------------------------
// Query string <-> filters
// ---------------------------------------------------------------------------

/** The server's query: the evidence box fans out into the two filters behind it. */
export function toApiQuery(filters: Filters, sort: SortKey, dir: 'asc' | 'desc'): URLSearchParams {
  const query = new URLSearchParams()
  const set = (key: string, value: string) => {
    if (value) query.set(key, value)
  }
  set('from', filters.from)
  set('to', filters.to)
  set('direction', filters.direction)
  set('search', filters.search)
  set('counterparty', filters.counterparty)
  set('status', filters.status)
  set('locked', filters.locked)
  set('reconciled', filters.reconciled)
  set('categoryId', filters.categoryId)
  set('vatRateCode', filters.vatRateCode)
  set('bankAccountId', filters.bankAccountId)
  set('minAmount', filters.minAmount)
  set('maxAmount', filters.maxAmount)
  if (filters.evidence === '1') query.set('hasEvidence', '1')
  if (filters.evidence === '0') {
    query.set('hasEvidence', '0')
    query.set('evidenceNotRequired', '0')
  }
  if (filters.evidence === 'x') query.set('evidenceNotRequired', '1')
  if (sort !== 'date' || dir !== 'desc') {
    query.set('sort', sort)
    query.set('dir', dir)
  }
  return query
}

/** The address bar's query: the filters as the screen holds them, so a link reopens the same view. */
export function toUrlQuery(filters: Filters, sort: SortKey, dir: 'asc' | 'desc'): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value)
  }
  if (sort !== 'date' || dir !== 'desc') {
    query.set('sort', sort)
    query.set('dir', dir)
  }
  return query.toString()
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/**
 * Reads the address bar. Understands the links the rest of the module already
 * hands out - ?status=draft, ?hasEvidence=0, ?direction=transfer - as well as
 * this screen's own.
 */
export function readFiltersFromUrl(search: string): { filters: Filters; sort: SortKey; dir: 'asc' | 'desc' } {
  const params = new URLSearchParams(search)
  const text = (key: string) => params.get(key) ?? ''
  let evidence: Filters['evidence'] = pick(params.get('evidence'), ['1', '0', 'x'] as const) ?? ''
  if (!evidence) {
    if (params.get('evidenceNotRequired') === '1') evidence = 'x'
    else if (params.get('hasEvidence') === '1') evidence = '1'
    else if (params.get('hasEvidence') === '0') evidence = '0'
  }
  return {
    filters: {
      from: text('from'),
      to: text('to'),
      direction: pick(params.get('direction'), ['income', 'expense', 'transfer'] as const) ?? '',
      search: text('search'),
      counterparty: text('counterparty'),
      status: pick(params.get('status'), ['posted', 'draft'] as const) ?? '',
      locked: pick(params.get('locked'), ['1', '0'] as const) ?? '',
      evidence,
      reconciled: pick(params.get('reconciled'), ['1', '0'] as const) ?? '',
      categoryId: text('categoryId'),
      vatRateCode: text('vatRateCode'),
      bankAccountId: text('bankAccountId'),
      minAmount: text('minAmount'),
      maxAmount: text('maxAmount'),
    },
    sort: pick(params.get('sort'), ['date', 'who', 'amount'] as const) ?? 'date',
    dir: params.get('dir') === 'asc' ? 'asc' : 'desc',
  }
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export type Chip = { key: keyof Filters | 'range'; label: string; clears: (keyof Filters)[] }

export function describeFilters(
  filters: Filters,
  lookups: { categories: Map<string, string>; accounts: Map<string, string> },
  formatDate: (value: string) => string,
): Chip[] {
  const chips: Chip[] = []
  if (filters.from || filters.to) {
    const label =
      filters.from && filters.to
        ? `${formatDate(filters.from)} to ${formatDate(filters.to)}`
        : filters.from
          ? `From ${formatDate(filters.from)}`
          : `Up to ${formatDate(filters.to)}`
    chips.push({ key: 'range', label, clears: ['from', 'to'] })
  }
  const single = (key: keyof Filters, label: string | null) => {
    if (filters[key] && label) chips.push({ key, label, clears: [key] })
  }
  single('direction', { income: 'Money in', expense: 'Money out', transfer: 'Internal transfers', '': '' }[filters.direction])
  single('search', filters.search ? `Matching “${filters.search}”` : null)
  single('counterparty', filters.counterparty ? `Who with: ${filters.counterparty}` : null)
  single('status', { posted: 'Recorded', draft: 'Waiting for review', '': '' }[filters.status])
  single('locked', { '1': 'On a filed return', '0': 'Not filed yet', '': '' }[filters.locked])
  single('evidence', { '1': 'Has a receipt', '0': 'Still needs a receipt', x: 'No receipt needed', '': '' }[filters.evidence])
  single('reconciled', { '1': 'Matched to the bank', '0': 'Not matched to the bank', '': '' }[filters.reconciled])
  single('categoryId', `Category: ${lookups.categories.get(filters.categoryId) ?? 'unknown'}`)
  single('vatRateCode', `VAT: ${VAT_RATE_LABELS[filters.vatRateCode] ?? filters.vatRateCode}`)
  single('bankAccountId', `Account: ${lookups.accounts.get(filters.bankAccountId) ?? 'unknown'}`)
  if (filters.minAmount || filters.maxAmount) {
    const label =
      filters.minAmount && filters.maxAmount
        ? `£${filters.minAmount} to £${filters.maxAmount}`
        : filters.minAmount
          ? `£${filters.minAmount} or more`
          : `£${filters.maxAmount} or less`
    chips.push({ key: 'minAmount', label, clears: ['minAmount', 'maxAmount'] })
  }
  return chips
}

/** Amounts are typed by people: "1,200", "£50", " 7.5 " all mean what they look like. */
export function cleanAmount(value: string): string {
  return value.replace(/[£,\s]/g, '')
}
