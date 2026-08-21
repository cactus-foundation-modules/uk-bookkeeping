import type { Prisma } from '@prisma/client'

/**
 * NUMERIC(10,2) comes back from prisma.$queryRaw as Prisma.Decimal.
 *
 * NEVER Number() one of these. Never JSON.stringify one and hope. Arithmetic
 * belongs in SQL; where it must happen in TypeScript, use Decimal methods and
 * .toFixed(2) at the very edge, once, on the way to the screen or to HMRC.
 * See lib/money.ts, which is the only place in this module allowed to turn a
 * decimal into a string.
 */
export type Money = Prisma.Decimal

export type Direction = 'income' | 'expense'
export type EntryType = 'normal' | 'adjustment' | 'opening_balance'
export type TransactionStatus = 'draft' | 'posted'
export type VatScheme = 'accrual' | 'cash'
export type PeriodFrequency = 'monthly' | 'quarterly' | 'annual'
export type PeriodStatus = 'open' | 'finalised' | 'submitted'
export type HmrcEnvironment = 'sandbox' | 'production'
export type BusinessType = 'ltd' | 'sole_trader'
export type BoxRounding = 'nearest' | 'down'

export type VatRateCode = 'standard' | 'reduced' | 'zero' | 'exempt' | 'outside_scope'

export type VatTreatment =
  | 'domestic'
  | 'ni_eu_acquisition' // goods into Northern Ireland from an EU member state
  | 'ni_eu_dispatch' // goods from Northern Ireland to an EU member state
  | 'reverse_charge_services' // services bought from overseas
  | 'import_pva' // postponed VAT accounting on imports
  | 'domestic_reverse_charge' // e.g. construction services
  | 'outside_scope'

export const VAT_RATE_CODES: VatRateCode[] = [
  'standard',
  'reduced',
  'zero',
  'exempt',
  'outside_scope',
]

export const VAT_TREATMENTS: VatTreatment[] = [
  'domestic',
  'ni_eu_acquisition',
  'ni_eu_dispatch',
  'reverse_charge_services',
  'import_pva',
  'domestic_reverse_charge',
  'outside_scope',
]

/** Plain English for the rate bands, used on the form and in reports. */
export const VAT_RATE_LABELS: Record<VatRateCode, string> = {
  standard: 'Standard rate',
  reduced: 'Reduced rate',
  zero: 'Zero rated',
  exempt: 'Exempt',
  outside_scope: 'Outside the scope of VAT',
}

/**
 * The rate each band carries today. Stored per line as well
 * (`vat_rate_percent`), so if the standard rate ever moves off 20% every
 * historic return still recomputes to what was filed.
 */
export const VAT_RATE_PERCENTS: Record<VatRateCode, string> = {
  standard: '20.00',
  reduced: '5.00',
  zero: '0.00',
  exempt: '0.00',
  outside_scope: '0.00',
}

export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  domestic: 'UK domestic',
  ni_eu_acquisition: 'Goods bought into Northern Ireland from the EU',
  ni_eu_dispatch: 'Goods sold from Northern Ireland to the EU',
  reverse_charge_services: 'Services bought from overseas (reverse charge)',
  import_pva: 'Imported goods (postponed VAT accounting)',
  domestic_reverse_charge: 'UK reverse charge (e.g. construction)',
  outside_scope: 'Outside the scope of VAT',
}

// ---------------------------------------------------------------------------
// Row types - what prisma.$queryRaw actually hands back
// ---------------------------------------------------------------------------

export type BkCategoryRow = {
  id: string
  code: string
  name: string
  direction: 'income' | 'expense' | 'both'
  sa103_box: string | null
  ct600_group: string | null
  is_trading: boolean
  is_capital: boolean
  position: number
  archived: boolean
  is_system: boolean
  created_at: Date
  updated_at: Date
}

export type BkTransactionRow = {
  id: string
  entry_type: EntryType
  direction: Direction
  tax_point_date: Date
  settled_date: Date | null
  counterparty: string
  description: string
  reference: string | null
  status: TransactionStatus
  source: string
  source_ref: string | null
  import_batch_id: string | null
  bank_account_id: string | null
  statement_id: string | null
  corrects_transaction_id: string | null
  correction_reason: string | null
  finalised_period_id: string | null
  locked_period_id: string | null
  locked_at: Date | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: Date
  updated_at: Date
}

export type BkTransactionLineRow = {
  id: string
  transaction_id: string
  position: number
  category_id: string
  description: string
  vat_treatment: VatTreatment
  vat_rate_code: VatRateCode
  vat_rate_percent: Money
  net_amount: Money
  vat_amount: Money
  gross_amount: Money
  is_capital: boolean
  locked_period_id: string | null
}

export type BkAttachmentRow = {
  id: string
  transaction_id: string
  name: string
  filename: string
  url: string
  media_provider: string | null
  media_key: string | null
  media_id: string | null
  mime_type: string
  size: number
  sha256: string | null
  position: number
  locked_period_id: string | null
  uploaded_by_user_id: string | null
  created_at: Date
}

export type BkVatPeriodRow = {
  id: string
  period_key: string | null
  start_date: Date
  end_date: Date
  due_date: Date | null
  status: PeriodStatus
  scheme: VatScheme
  source: 'local' | 'hmrc'
  obligation_status: string | null
  vrn: string | null
  finalised_at: Date | null
  finalised_by_user_id: string | null
  submitted_at: Date | null
  submitted_by_user_id: string | null
  submitted_externally: boolean
  hmrc_processing_date: Date | null
  hmrc_form_bundle_number: string | null
  hmrc_charge_ref_number: string | null
  hmrc_payment_indicator: string | null
  hmrc_receipt_id: string | null
  hmrc_receipt_timestamp: string | null
  hmrc_correlation_id: string | null
  created_at: Date
  updated_at: Date
}

// ---------------------------------------------------------------------------
// Bank accounts, statements and reconciliation
// ---------------------------------------------------------------------------

export type BankAccountKind = 'bank' | 'card' | 'cash'
export type BankTransactionStatus = 'unreconciled' | 'reconciled' | 'ignored'
export type MatchMethod = 'manual' | 'suggested' | 'import'

export type BkBankAccountRow = {
  id: string
  name: string
  kind: BankAccountKind
  bank_name: string | null
  account_last4: string | null
  sort_code: string | null
  opening_balance: Money
  opening_date: Date | null
  archived: boolean
  position: number
  created_at: Date
  updated_at: Date
}

export type BkBankStatementRow = {
  id: string
  bank_account_id: string
  filename: string
  format: 'csv' | 'pdf'
  preset: string | null
  period_start: Date | null
  period_end: Date | null
  opening_balance: Money | null
  closing_balance: Money | null
  total_paid_in: Money | null
  total_paid_out: Money | null
  row_count: number
  imported_count: number
  duplicate_count: number
  mapping: unknown
  created_by_user_id: string | null
  created_at: Date
}

export type BkBankTransactionRow = {
  id: string
  bank_account_id: string
  statement_id: string | null
  date: Date
  details: string
  counterparty: string
  reference: string | null
  transaction_type: string | null
  /** Signed: positive is money in, negative is money out. */
  amount: Money
  statement_balance: Money | null
  fingerprint: string
  status: BankTransactionStatus
  ignored_reason: string | null
  created_at: Date
  updated_at: Date
}

export type BkReconciliationRow = {
  id: string
  bank_transaction_id: string
  transaction_id: string
  amount: Money
  match_method: MatchMethod
  created_by_user_id: string | null
  created_at: Date
}

// ---------------------------------------------------------------------------
// Ledger accounts and journals
// ---------------------------------------------------------------------------

export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export type AccountSubtype =
  | 'other'
  | 'bank'
  | 'cash'
  | 'director_loan'
  | 'vat_control'
  | 'debtors'
  | 'creditors'
  | 'fixed_assets'
  | 'depreciation'
  | 'share_capital'
  | 'reserves'
  | 'suspense'
  | 'profit_and_loss'

export type JournalStatus = 'draft' | 'posted'

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  asset: 'Things the business owns or is owed',
  liability: 'Things the business owes',
  equity: 'The owners’ stake',
  income: 'Income',
  expense: 'Costs',
}

/**
 * Which side of an account an increase falls on.
 *
 * Assets and costs go up on the debit side; everything else goes up on the
 * credit side. This is the one piece of double-entry convention the module has
 * to state outright, and every balance it works out reads from here rather than
 * from a sign convention repeated in four places.
 */
export const INCREASES_ON_DEBIT: Record<AccountKind, boolean> = {
  asset: true,
  expense: true,
  liability: false,
  equity: false,
  income: false,
}

export type BkAccountRow = {
  id: string
  code: string
  name: string
  kind: AccountKind
  subtype: AccountSubtype
  category_id: string | null
  bank_account_id: string | null
  person_name: string | null
  position: number
  archived: boolean
  is_system: boolean
  created_at: Date
  updated_at: Date
}

export type BkJournalRow = {
  id: string
  date: Date
  reference: string | null
  narrative: string
  status: JournalStatus
  source: string
  reverses_journal_id: string | null
  reversed_by_journal_id: string | null
  finalised_period_id: string | null
  locked_period_id: string | null
  locked_at: Date | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: Date
  updated_at: Date
}

export type BkJournalLineRow = {
  id: string
  journal_id: string
  position: number
  account_id: string
  description: string
  debit: Money
  credit: Money
  locked_period_id: string | null
  created_at: Date
  updated_at: Date
}

export type BkSettingsRow = {
  id: string
  business_name: string | null
  business_type: BusinessType
  vrn: string | null
  vat_registered_from: Date | null
  scheme: VatScheme
  scheme_changed_at: Date | null
  period_frequency: PeriodFrequency
  first_period_start: Date | null
  first_period_end: Date | null
  hmrc_environment: HmrcEnvironment
  error_threshold_fixed: Money
  error_threshold_percent: Money
  error_threshold_cap: Money
  box_rounding: BoxRounding
  attachment_max_bytes: number
  retention_years: number
  vendor_public_ip: string | null
  /** The accounting year end, as a month and a day: "31 March", not a date. */
  year_end_month: number
  year_end_day: number
  /** Sales handed over by another module (see lib/external-sales.ts): whether to
   *  take them at all, what to file them under, and whether they land as records
   *  or as drafts for a human to look at. */
  external_sales_enabled: boolean
  external_sales_category_id: string | null
  external_sales_status: 'draft' | 'posted'
  created_at: Date
  updated_at: Date
}

export type BkHmrcConnectionRow = {
  id: string
  vrn: string | null
  environment: HmrcEnvironment
  status: 'never' | 'connected' | 'expired' | 'revoked'
  access_token_encrypted: string | null
  access_token_expires_at: Date | null
  refresh_token_encrypted: string | null
  refresh_token_expires_at: Date | null
  scope: string | null
  connected_at: Date | null
  connected_by_user_id: string | null
  last_refresh_at: Date | null
  last_refresh_error: string | null
  updated_at: Date
}

// ---------------------------------------------------------------------------
// The nine boxes
// ---------------------------------------------------------------------------

/**
 * Always decimal STRINGS, never numbers, at any point in this module.
 *
 * The field names are HMRC's own, so the submission payload is the snapshot with
 * `finalised: true` bolted on and there is no intermediate mapping step where a
 * value could be typed, transposed or quietly turned into a float.
 *
 * Boxes 1 to 5 carry real pence. Boxes 6 to 9 are whole pounds, but HMRC's API
 * describes them as "a monetary value (to 2 zeroed decimal places)", so they are
 * held here as e.g. "1234.00" - a whole pound figure that happens to be written
 * with its zeroed pence. Sending a bare integer there is not what the schema
 * asks for.
 */
export type VatBoxes = {
  vatDueSales: string // box 1
  vatDueAcquisitions: string // box 2
  totalVatDue: string // box 3
  vatReclaimedCurrPeriod: string // box 4
  netVatDue: string // box 5, non-negative
  totalValueSalesExVAT: string // box 6, whole pounds
  totalValuePurchasesExVAT: string // box 7, whole pounds
  totalValueGoodsSuppliedExVAT: string // box 8, whole pounds
  totalAcquisitionsExVAT: string // box 9, whole pounds
}

export const VAT_BOX_KEYS: (keyof VatBoxes)[] = [
  'vatDueSales',
  'vatDueAcquisitions',
  'totalVatDue',
  'vatReclaimedCurrPeriod',
  'netVatDue',
  'totalValueSalesExVAT',
  'totalValuePurchasesExVAT',
  'totalValueGoodsSuppliedExVAT',
  'totalAcquisitionsExVAT',
]

export const VAT_BOX_NUMBERS: Record<keyof VatBoxes, number> = {
  vatDueSales: 1,
  vatDueAcquisitions: 2,
  totalVatDue: 3,
  vatReclaimedCurrPeriod: 4,
  netVatDue: 5,
  totalValueSalesExVAT: 6,
  totalValuePurchasesExVAT: 7,
  totalValueGoodsSuppliedExVAT: 8,
  totalAcquisitionsExVAT: 9,
}

export const VAT_BOX_LABELS: Record<keyof VatBoxes, string> = {
  vatDueSales: 'VAT due on sales and other outputs',
  vatDueAcquisitions:
    'VAT due on acquisitions from EU member states brought into Northern Ireland',
  totalVatDue: 'Total VAT due (boxes 1 and 2 added together)',
  vatReclaimedCurrPeriod: 'VAT reclaimed on purchases and other inputs',
  netVatDue: 'Net VAT to pay HMRC or reclaim',
  totalValueSalesExVAT: 'Total value of sales and other outputs, excluding VAT',
  totalValuePurchasesExVAT: 'Total value of purchases and other inputs, excluding VAT',
  totalValueGoodsSuppliedExVAT:
    'Total value of goods supplied from Northern Ireland to EU member states, excluding VAT',
  totalAcquisitionsExVAT:
    'Total value of goods acquired from EU member states into Northern Ireland, excluding VAT',
}

/** Boxes 6 to 9: whole pounds, and the only ones the rounding rule touches. */
export const WHOLE_POUND_BOXES: (keyof VatBoxes)[] = [
  'totalValueSalesExVAT',
  'totalValuePurchasesExVAT',
  'totalValueGoodsSuppliedExVAT',
  'totalAcquisitionsExVAT',
]

/** One line's contribution, with the boxes it landed in. */
export type SnapshotLine = {
  transactionId: string
  lineId: string
  direction: Direction
  vatTreatment: VatTreatment
  vatRateCode: VatRateCode
  netAmount: string
  vatAmount: string
  boxes: string[]
}
