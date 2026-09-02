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
  /** "There is no receipt for this one, and there is not meant to be." */
  evidence_not_required: boolean
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
  /**
   * "Put this on the asset register." Not the same thing as is_capital, which
   * is an accounting treatment that follows the category: a stage payment on a
   * building is capital and is not a separate asset.
   */
  register_asset: boolean
  locked_period_id: string | null
}

/** What we made of a document we read. See migrations/016_document_inbox.sql. */
export type AttachmentScanStatus = 'not_scanned' | 'read' | 'no_text' | 'unreadable'

export type BkAttachmentRow = {
  id: string
  /**
   * NULL while the document is still in the inbox waiting to be filed. Evidence
   * exists before the entry does far more often than after it - the receipt
   * arrives by email on the day, the entry gets typed when the statement turns
   * up - so an attachment is allowed to stand on its own until somebody says
   * what it belongs to.
   */
  transaction_id: string | null
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
  // --- What we read off it. Guesses, every one, and never an accounting figure
  // --- on its own: they pre-fill a form somebody then presses Save on.
  scan_status: AttachmentScanStatus
  scanned_at: Date | null
  guessed_counterparty: string | null
  counterparty_confidence: number
  guessed_direction: Direction | null
  guessed_document_date: Date | null
  guessed_document_number: string | null
  guessed_net: Money | null
  guessed_vat: Money | null
  guessed_total: Money | null
  guessed_vat_rate_code: VatRateCode | null
  /** How the VAT works, which is not the same question as at what rate. */
  guessed_vat_treatment: VatTreatment | null
  guessed_vat_number: string | null
  reading_confirmed: boolean
  extracted_text: string | null
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
  // --- The file itself. See migrations/019_statement_files.sql. Null on any
  // --- statement imported before that existed, and on a site with no file
  // --- storage set up.
  url: string | null
  media_provider: string | null
  media_key: string | null
  media_id: string | null
  mime_type: string | null
  size: number
  sha256: string | null
  updated_at: Date
  updated_by_user_id: string | null
  /** How many times this statement has been brought in again to correct it. */
  update_count: number
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
  /** Exactly one of these two is set - see 020_transfers.sql. */
  transaction_id: string | null
  journal_id: string | null
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
  | 'vat_deferred'
  | 'debtors'
  | 'creditors'
  | 'fixed_assets'
  | 'depreciation'
  | 'share_capital'
  | 'reserves'
  | 'suspense'
  | 'profit_and_loss'
  | 'stock'
  | 'intangibles'
  | 'provisions'

/**
 * Which line of the profit and loss account an account prints on.
 *
 * Plain strings rather than a closed union in the database, for the same reason
 * bk_categories keeps sa103_box as text: these are groupings on forms that HMRC
 * renumbers, and a renumbering should be an edit and not a release. The union
 * here is what the module ships knowing about.
 */
export type ReportGroup =
  | 'turnover'
  | 'other-income'
  | 'non-trade-income'
  | 'property-income'
  | 'cost-of-sales'
  | 'staff-costs'
  | 'admin-expenses'
  | 'depreciation'
  | 'finance-costs'
  | 'tax'

/** Which line of the balance sheet an account prints on. */
export type BalanceSheetGroup =
  | 'fixed_assets'
  | 'intangible_assets'
  | 'current_assets_stock'
  | 'current_assets_debtors'
  | 'current_assets_cash'
  | 'creditors_short'
  | 'creditors_long'
  | 'provisions'
  | 'share_capital'
  | 'reserves'

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
  /** Which profit and loss line. NULL on balance sheet accounts. */
  report_group: string | null
  /** Which balance sheet line. NULL on profit and loss accounts. */
  bs_group: string | null
  /** How much of what lands here the taxman disallows, as a percentage. */
  disallowable_percent: Money
  position: number
  archived: boolean
  is_system: boolean
  created_at: Date
  updated_at: Date
}

/**
 * An ordinary journal, or the one special shape of journal that has its own
 * form: money moved between two accounts the business already owns.
 */
export type JournalKind = 'journal' | 'transfer'

export type BkJournalRow = {
  id: string
  date: Date
  reference: string | null
  narrative: string
  status: JournalStatus
  kind: JournalKind
  /** Both set on a transfer, both null on anything else. */
  from_bank_account_id: string | null
  to_bank_account_id: string | null
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
  /** Raw install licence identifier. Hashed before it goes anywhere near HMRC. */
  vendor_license_id: string | null
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

// ---------------------------------------------------------------------------
// Financial years
// ---------------------------------------------------------------------------

export type AccountingPeriodStatus = 'open' | 'closed'

export type BkAccountingPeriodRow = {
  id: string
  name: string
  start_date: Date
  end_date: Date
  status: AccountingPeriodStatus
  close_journal_id: string | null
  closed_at: Date | null
  closed_by_user_id: string | null
  notes: string | null
  created_at: Date
  updated_at: Date
}

// ---------------------------------------------------------------------------
// Fixed assets
// ---------------------------------------------------------------------------

export type DepreciationMethod = 'straight_line' | 'reducing_balance' | 'none'

/**
 * Where an asset is up to.
 *
 * A 'draft' is one the module raised itself, off a ticked purchase line, and
 * which nobody has yet said how to depreciate or which allowances it qualifies
 * for. It is inert until they do: no depreciation is charged on it and it
 * claims nothing, because both of those are judgements about the asset and
 * this module does not invent judgements. 'active' is a finished register
 * entry, which is what every asset added by hand is from the moment it is
 * saved.
 */
export type FixedAssetStatus = 'draft' | 'active'

/**
 * Which capital allowances pool an asset's cost goes in.
 *
 * These are HMRC's categories, not this module's, and choosing between them is
 * a judgement about the asset rather than about the bookkeeping - which is why
 * it is a field on the asset and not something the module works out.
 */
export type CapitalAllowancePool =
  | 'aia' // annual investment allowance: 100%, up to the yearly cap
  | 'full_expensing' // 100% first year allowance, new main-rate plant, companies
  | 'fya_special' // 50% first year allowance, new special rate plant
  | 'main' // main pool, 18% a year
  | 'special' // special rate pool, 6% a year
  | 'none' // no allowances

export const DEPRECIATION_METHOD_LABELS: Record<DepreciationMethod, string> = {
  straight_line: 'Same amount every year',
  reducing_balance: 'A percentage of what is left each year',
  none: 'Do not depreciate',
}

export const CA_POOL_LABELS: Record<CapitalAllowancePool, string> = {
  aia: 'Annual investment allowance (the whole cost, up to the yearly cap)',
  full_expensing: 'Full expensing (the whole cost, new equipment only)',
  fya_special: '50% first year allowance (new integral features and long-life assets)',
  main: 'Main pool (18% a year)',
  special: 'Special rate pool (6% a year - cars, integral features, long-life assets)',
  none: 'No tax allowances',
}

export type BkFixedAssetRow = {
  id: string
  description: string
  reference: string | null
  acquired_date: Date
  cost: Money
  status: FixedAssetStatus
  transaction_id: string | null
  /** Which line of that purchase, so one receipt can raise two assets. */
  transaction_line_position: number | null
  asset_account_id: string
  depreciation_account_id: string
  expense_account_id: string
  depreciation_method: DepreciationMethod
  depreciation_rate: Money
  residual_value: Money
  ca_pool: CapitalAllowancePool
  disposed_date: Date | null
  disposal_proceeds: Money | null
  disposal_transaction_id: string | null
  notes: string | null
  archived: boolean
  created_by_user_id: string | null
  created_at: Date
  updated_at: Date
}

export type BkDepreciationChargeRow = {
  id: string
  asset_id: string
  period_start: Date
  period_end: Date
  amount: Money
  journal_id: string
  created_at: Date
}

// ---------------------------------------------------------------------------
// Corporation tax
// ---------------------------------------------------------------------------

export type CtComputationStatus = 'draft' | 'final'

export type CtAdjustmentKind =
  | 'add_back'
  | 'deduction'
  | 'capital_allowance'
  | 'balancing_charge'
  | 'non_trade_income'
  | 'property_income'
  | 'other_income'
  | 'chargeable_gain'
  | 'loss_bf'
  | 'loss_cy'
  | 'group_relief'
  | 'qualifying_donations'
  | 'management_expenses'
  | 'franked_investment_income'

export const CT_ADJUSTMENT_LABELS: Record<CtAdjustmentKind, string> = {
  add_back: 'Cost the taxman will not allow',
  deduction: 'Extra deduction not in the accounts',
  capital_allowance: 'Extra capital allowances claimed',
  balancing_charge: 'Balancing charge',
  non_trade_income: 'Bank interest and other non-trading income',
  property_income: 'Income from property',
  other_income: 'Other income',
  chargeable_gain: 'Gain on selling an asset',
  loss_bf: 'Trading losses brought forward, used',
  loss_cy: 'This period’s loss set against other profits',
  group_relief: 'Group relief claimed',
  qualifying_donations: 'Charitable donations',
  management_expenses: 'Management expenses',
  franked_investment_income: 'Dividends received from other companies',
}

export type BkCtRateRow = {
  financial_year: number
  main_rate: Money
  small_profits_rate: Money | null
  lower_limit: Money | null
  upper_limit: Money | null
  mr_numerator: number | null
  mr_denominator: number | null
  aia_limit: Money
  main_pool_wda: Money
  special_pool_wda: Money
  small_pool_limit: Money
  full_expensing_rate: Money | null
  fya_special_rate: Money | null
  notes: string | null
  updated_at: Date
}

export type BkCtComputationRow = {
  id: string
  accounting_period_id: string
  start_date: Date
  end_date: Date
  status: CtComputationStatus
  associated_companies: number
  main_pool_bf: Money
  special_pool_bf: Money
  losses_bf: Money
  claim_aia: boolean
  claim_full_expensing: boolean
  computation: unknown
  boxes: unknown
  tax_due: Money | null
  main_pool_cf: Money | null
  special_pool_cf: Money | null
  losses_cf: Money | null
  finalised_at: Date | null
  finalised_by_user_id: string | null
  created_by_user_id: string | null
  created_at: Date
  updated_at: Date
}

export type BkCtAdjustmentRow = {
  id: string
  computation_id: string
  position: number
  kind: CtAdjustmentKind
  label: string
  amount: Money
  note: string | null
  created_at: Date
  updated_at: Date
}
