import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit, getChainHead, nextChainLink, chainHash } from './audit'
import { BookkeepingError, NotFoundError, PeriodStateError } from './errors'
import { formatMoney, formatPounds, toMoney } from './money'
import { getSettings } from './settings'
import type {
  BkVatPeriodRow,
  PeriodFrequency,
  SnapshotLine,
  VatBoxes,
  VatScheme,
} from './types'
import { boxesMatch, computeVatReturn, netVatDirection } from './vat-boxes'

// The period lifecycle: open → finalised → submitted, with `submitted` terminal.
//
// There is deliberately no unsubmit path. A superseding return in HMRC's own
// system is a new obligation with its own period key, so it becomes a new period
// record here. An unsubmit door is the one through which every immutability
// guarantee eventually leaks.

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Whether a return is late. Worked out on the SERVER and sent to the browser as
 * a flag: "is it overdue" is a question about the current moment, and reading
 * the clock while rendering makes a component's output depend on when React
 * happened to re-run it.
 */
export function isOverdue(period: { status: string; due_date: Date | null }): boolean {
  if (period.status === 'submitted' || !period.due_date) return false
  return period.due_date.getTime() < Date.now()
}

export async function listPeriods(): Promise<BkVatPeriodRow[]> {
  return prisma.$queryRaw<BkVatPeriodRow[]>`
    SELECT * FROM "bk_vat_periods" ORDER BY "start_date" DESC
  `
}

export async function getPeriod(id: string): Promise<BkVatPeriodRow | null> {
  const rows = await prisma.$queryRaw<BkVatPeriodRow[]>`
    SELECT * FROM "bk_vat_periods" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

export async function requirePeriod(id: string): Promise<BkVatPeriodRow> {
  const period = await getPeriod(id)
  if (!period) throw new NotFoundError('That VAT period')
  return period
}

export type PeriodSnapshot = {
  id: string
  kind: 'finalised' | 'submitted'
  scheme: VatScheme
  boxes: VatBoxes
  boxesUnrounded: Record<string, string>
  vrn: string | null
  createdAt: Date
  chainIndex: string
  rowHash: string
}

export async function listSnapshots(periodId: string): Promise<PeriodSnapshot[]> {
  const rows = await prisma.$queryRaw<
    {
      id: string
      kind: 'finalised' | 'submitted'
      scheme: VatScheme
      boxes: VatBoxes
      boxes_unrounded: Record<string, string>
      vrn: string | null
      created_at: Date
      chain_index: bigint
      row_hash: string
    }[]
  >`
    SELECT "id", "kind", "scheme", "boxes", "boxes_unrounded", "vrn",
           "created_at", "chain_index", "row_hash"
    FROM "bk_period_snapshots" WHERE "period_id" = ${periodId}
    ORDER BY "chain_index" ASC
  `
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    scheme: r.scheme,
    boxes: r.boxes,
    boxesUnrounded: r.boxes_unrounded,
    vrn: r.vrn,
    createdAt: r.created_at,
    chainIndex: r.chain_index.toString(),
    rowHash: r.row_hash,
  }))
}

export async function getSnapshotWorkings(snapshotId: string): Promise<SnapshotLine[]> {
  const rows = await prisma.$queryRaw<
    {
      transaction_id: string
      line_id: string
      direction: 'income' | 'expense'
      vat_treatment: SnapshotLine['vatTreatment']
      vat_rate_code: SnapshotLine['vatRateCode']
      net_amount: Prisma.Decimal
      vat_amount: Prisma.Decimal
      boxes: string[]
    }[]
  >`
    SELECT "transaction_id", "line_id", "direction", "vat_treatment", "vat_rate_code",
           "net_amount", "vat_amount", "boxes"
    FROM "bk_period_snapshot_lines" WHERE "snapshot_id" = ${snapshotId}
  `
  return rows.map((r) => ({
    transactionId: r.transaction_id,
    lineId: r.line_id,
    direction: r.direction,
    vatTreatment: r.vat_treatment,
    vatRateCode: r.vat_rate_code,
    netAmount: formatMoney(r.net_amount),
    vatAmount: formatMoney(r.vat_amount),
    boxes: r.boxes,
  }))
}

/**
 * A period's figures as they stand right now, recomputed from the records.
 *
 * Always recomputed, never read back from a stored total. Reading a stored
 * total is exactly how a return comes to disagree with the records that are
 * supposed to have produced it.
 */
export async function computePeriod(period: BkVatPeriodRow) {
  const settings = await getSettings()
  // The period's OWN scheme, not the current setting: switching accrual to cash
  // must not silently restate a return that was filed two years ago.
  return computeVatReturn(period.start_date, period.end_date, period.scheme, settings.box_rounding)
}

// ---------------------------------------------------------------------------
// Creating periods
// ---------------------------------------------------------------------------

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime())
  next.setUTCMonth(next.getUTCMonth() + months)
  return next
}

function monthsPerPeriod(frequency: PeriodFrequency): number {
  return frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12
}

function endOfPeriod(start: Date, frequency: PeriodFrequency): Date {
  const end = addMonths(start, monthsPerPeriod(frequency))
  end.setUTCDate(end.getUTCDate() - 1)
  return end
}

export function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/**
 * Lay out periods from the scheme and frequency, up to and including the one
 * that covers today. Local periods only: once HMRC is connected, real
 * obligations are matched onto these by date range.
 */
export async function generateLocalPeriods(user: SessionUser | null): Promise<BkVatPeriodRow[]> {
  const settings = await getSettings()
  if (!settings.first_period_start) {
    throw new BookkeepingError(
      'invalid',
      'Set the date your first VAT period starts, in Settings, and we will lay the periods out from there.',
    )
  }

  const frequency = settings.period_frequency
  const created: string[] = []
  let start = new Date(settings.first_period_start)
  const horizon = addMonths(new Date(), monthsPerPeriod(frequency))

  // A guard rather than a `while (true)`: a first-period-start set to 1970 by
  // accident should produce a refusal, not four hundred rows.
  for (let i = 0; i < 200 && start <= horizon; i += 1) {
    const end = endOfPeriod(start, frequency)
    const [existing] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "bk_vat_periods"
      WHERE "start_date" = ${start}::date AND "end_date" = ${end}::date LIMIT 1
    `
    if (!existing) {
      const [row] = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "bk_vat_periods" ("start_date", "end_date", "scheme", "source", "vrn")
        VALUES (${start}::date, ${end}::date, ${settings.scheme}, 'local', ${settings.vrn})
        RETURNING "id"
      `
      if (row) created.push(row.id)
    }
    start = addMonths(start, monthsPerPeriod(frequency))
  }

  if (created.length > 0) {
    await appendAudit({
      action: 'period.created',
      entityType: 'vat_period',
      summary: `${created.length} VAT period${created.length === 1 ? '' : 's'} laid out from your scheme settings`,
      detail: { created },
      user,
    })
  }
  return listPeriods()
}

// ---------------------------------------------------------------------------
// Finalise
// ---------------------------------------------------------------------------

/** Every transaction whose lines land in this period, under this period's scheme. */
async function contributingTransactionIds(period: BkVatPeriodRow): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT t."id"
    FROM "bk_transactions" t
    JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE t."status" = 'posted'
      AND (
        (${period.scheme}::text = 'accrual'
          AND t."tax_point_date" BETWEEN ${period.start_date}::date AND ${period.end_date}::date)
        OR (${period.scheme}::text = 'cash' AND t."settled_date" IS NOT NULL
          AND t."settled_date" BETWEEN ${period.start_date}::date AND ${period.end_date}::date)
      )
  `
  return rows.map((r) => r.id)
}

/** Imported rows still awaiting review, which must be dealt with before filing. */
async function countDraftsInRange(period: BkVatPeriodRow): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_transactions"
    WHERE "status" = 'draft'
      AND "tax_point_date" BETWEEN ${period.start_date}::date AND ${period.end_date}::date
  `
  return Number(row?.count ?? 0n)
}

export async function writeSnapshot(
  tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  input: {
    periodId: string
    kind: 'finalised' | 'submitted'
    scheme: VatScheme
    boxes: VatBoxes
    unrounded: Record<string, string>
    lines: SnapshotLine[]
    vrn: string | null
    user: SessionUser | null
  },
): Promise<string> {
  const { chainIndex, prevHash } = await nextChainLink('bk_period_snapshots')
  const payload = {
    periodId: input.periodId,
    kind: input.kind,
    scheme: input.scheme,
    boxes: input.boxes,
    boxesUnrounded: input.unrounded,
    vrn: input.vrn,
  }
  const rowHash = chainHash(chainIndex, prevHash, payload)

  const [snapshot] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "bk_period_snapshots" (
      "period_id", "kind", "scheme", "boxes", "boxes_unrounded", "vrn",
      "created_by_user_id", "chain_index", "prev_hash", "row_hash"
    ) VALUES (
      ${input.periodId}, ${input.kind}, ${input.scheme},
      ${JSON.stringify(input.boxes)}::jsonb, ${JSON.stringify(input.unrounded)}::jsonb,
      ${input.vrn}, ${input.user?.id ?? null}, ${chainIndex}, ${prevHash}, ${rowHash}
    )
    RETURNING "id"
  `
  const snapshotId = snapshot!.id

  for (const line of input.lines) {
    await tx.$executeRaw`
      INSERT INTO "bk_period_snapshot_lines" (
        "snapshot_id", "transaction_id", "line_id", "direction", "vat_treatment",
        "vat_rate_code", "net_amount", "vat_amount", "boxes"
      ) VALUES (
        ${snapshotId}, ${line.transactionId}, ${line.lineId}, ${line.direction},
        ${line.vatTreatment}, ${line.vatRateCode},
        ${line.netAmount}::numeric, ${line.vatAmount}::numeric,
        ${JSON.stringify(line.boxes)}::jsonb
      )
    `
  }
  return snapshotId
}

export async function finalisePeriod(id: string, user: SessionUser | null): Promise<BkVatPeriodRow> {
  const period = await requirePeriod(id)
  if (period.status !== 'open') {
    throw new PeriodStateError(
      period.status === 'submitted'
        ? 'That return has already been filed.'
        : 'That return has already been finalised.',
    )
  }

  const drafts = await countDraftsInRange(period)
  if (drafts > 0) {
    throw new PeriodStateError(
      `There ${drafts === 1 ? 'is' : 'are'} still ${drafts} imported entr${drafts === 1 ? 'y' : 'ies'} in this period waiting to be reviewed. Deal with those first, then finalise.`,
    )
  }

  const computed = await computePeriod(period)
  const settings = await getSettings()
  const contributing = await contributingTransactionIds(period)

  await prisma.$transaction(async (tx) => {
    await writeSnapshot(tx, {
      periodId: period.id,
      kind: 'finalised',
      scheme: period.scheme,
      boxes: computed.boxes,
      unrounded: computed.unrounded,
      lines: computed.lines,
      vrn: period.vrn ?? settings.vrn,
      user,
    })
    if (contributing.length > 0) {
      await tx.$executeRaw`
        UPDATE "bk_transactions" SET "finalised_period_id" = ${period.id}, "updated_at" = NOW()
        WHERE "id" = ANY(${contributing}::text[]) AND "locked_period_id" IS NULL
      `
    }
    await tx.$executeRaw`
      UPDATE "bk_vat_periods"
      SET "status" = 'finalised', "finalised_at" = NOW(), "finalised_by_user_id" = ${user?.id ?? null},
          "updated_at" = NOW()
      WHERE "id" = ${period.id}
    `
  })

  await appendAudit({
    action: 'period.finalised',
    entityType: 'vat_period',
    entityId: period.id,
    summary: `VAT return for ${toDateOnly(period.start_date)} to ${toDateOnly(period.end_date)} finalised`,
    detail: { boxes: computed.boxes, transactions: contributing.length },
    user,
  })

  return requirePeriod(period.id)
}

export async function unfinalisePeriod(id: string, user: SessionUser | null): Promise<BkVatPeriodRow> {
  const period = await requirePeriod(id)
  if (period.status === 'submitted') {
    throw new PeriodStateError(
      'That return has been filed with HMRC. Corrections go in the current open period as new entries.',
    )
  }
  if (period.status !== 'finalised') {
    throw new PeriodStateError('That return is not finalised, so there is nothing to undo.')
  }

  await prisma.$transaction(async (tx) => {
    // The snapshot stays. It is append-only, and it is now the evidence of what
    // the numbers were before somebody changed their mind.
    await tx.$executeRaw`
      UPDATE "bk_transactions" SET "finalised_period_id" = NULL, "updated_at" = NOW()
      WHERE "finalised_period_id" = ${period.id} AND "locked_period_id" IS NULL
    `
    await tx.$executeRaw`
      UPDATE "bk_vat_periods"
      SET "status" = 'open', "finalised_at" = NULL, "finalised_by_user_id" = NULL, "updated_at" = NOW()
      WHERE "id" = ${period.id}
    `
  })

  await appendAudit({
    action: 'period.unfinalised',
    entityType: 'vat_period',
    entityId: period.id,
    summary: `VAT return for ${toDateOnly(period.start_date)} to ${toDateOnly(period.end_date)} reopened`,
    user,
  })

  return requirePeriod(period.id)
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * The hard lock, applied when a return is filed - by us or elsewhere.
 *
 * Called last within the submitting transaction, after the receipt is stored,
 * because a crash between the two states must leave a period that is
 * submitted-and-unlocked (recoverable, and visible to a consistency check)
 * rather than locked-with-no-receipt, which is a mystery.
 */
export async function lockPeriodRecords(
  tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  periodId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "bk_transaction_lines" SET "locked_period_id" = ${periodId}, "updated_at" = NOW()
    WHERE "locked_period_id" IS NULL AND "transaction_id" IN (
      SELECT "id" FROM "bk_transactions" WHERE "finalised_period_id" = ${periodId}
    )
  `
  await tx.$executeRaw`
    UPDATE "bk_attachments" SET "locked_period_id" = ${periodId}
    WHERE "locked_period_id" IS NULL AND "transaction_id" IN (
      SELECT "id" FROM "bk_transactions" WHERE "finalised_period_id" = ${periodId}
    )
  `
  await tx.$executeRaw`
    UPDATE "bk_transactions"
    SET "locked_period_id" = ${periodId}, "locked_at" = NOW(), "updated_at" = NOW()
    WHERE "finalised_period_id" = ${periodId} AND "locked_period_id" IS NULL
  `
}

/**
 * Filed through some other tool, and recorded here so the records lock anyway.
 * Keeps the module honest for anyone who never gets production approval from
 * HMRC - and that is a real outcome, not a hypothetical one.
 */
export async function markSubmittedElsewhere(
  id: string,
  user: SessionUser | null,
): Promise<BkVatPeriodRow> {
  const period = await requirePeriod(id)
  if (period.status !== 'finalised') {
    throw new PeriodStateError(
      period.status === 'submitted'
        ? 'That return is already recorded as filed.'
        : 'Finalise the return first, so there is a frozen set of figures to record.',
    )
  }

  const computed = await computePeriod(period)
  const settings = await getSettings()

  await prisma.$transaction(async (tx) => {
    await writeSnapshot(tx, {
      periodId: period.id,
      kind: 'submitted',
      scheme: period.scheme,
      boxes: computed.boxes,
      unrounded: computed.unrounded,
      lines: computed.lines,
      vrn: period.vrn ?? settings.vrn,
      user,
    })
    await tx.$executeRaw`
      UPDATE "bk_vat_periods"
      SET "submitted_externally" = TRUE, "submitted_at" = NOW(),
          "submitted_by_user_id" = ${user?.id ?? null}, "updated_at" = NOW()
      WHERE "id" = ${period.id}
    `
    await lockPeriodRecords(tx, period.id)
    await tx.$executeRaw`
      UPDATE "bk_vat_periods" SET "status" = 'submitted', "updated_at" = NOW() WHERE "id" = ${period.id}
    `
  })

  await appendAudit({
    action: 'period.marked-submitted-elsewhere',
    entityType: 'vat_period',
    entityId: period.id,
    summary: `VAT return for ${toDateOnly(period.start_date)} to ${toDateOnly(period.end_date)} recorded as filed elsewhere`,
    detail: { boxes: computed.boxes },
    user,
  })

  return requirePeriod(period.id)
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type NetErrors = {
  net: string
  threshold: string
  overThreshold: boolean
  cap: string
  boxSixTurnover: string
}

/**
 * The running "net errors on previous returns" figure, and the threshold it is
 * measured against.
 *
 * The rule, checked against VAT Notice 700/45 on 2026-08-20: an error can be put
 * right on the next return (their Method 1) when its net value does not exceed
 * £10,000, or when it is between £10,000 and £50,000 and does not exceed 1% of
 * the box 6 figure. Above that, HMRC wants telling separately (Method 2).
 *
 * Form VAT652 was withdrawn on 5 September 2025 and the separate notification is
 * now made through HMRC's online error-correction service, so the module links
 * to the notice rather than to a form that no longer exists.
 *
 * All three numbers are settings with those defaults, so a rule change is a
 * settings edit and not a release, and the wording is guidance with a link
 * rather than a determination.
 */
export async function computeNetErrors(period: BkVatPeriodRow): Promise<NetErrors> {
  const settings = await getSettings()

  const [row] = await prisma.$queryRaw<{ net: Prisma.Decimal }[]>`
    SELECT COALESCE(SUM(
      CASE WHEN t."direction" = 'income' THEN l."vat_amount" ELSE -l."vat_amount" END
    ), 0)::numeric AS net
    FROM "bk_transaction_lines" l
    JOIN "bk_transactions" t ON t."id" = l."transaction_id"
    WHERE t."entry_type" = 'adjustment'
      AND t."locked_period_id" IS NULL
      AND t."corrects_transaction_id" IS NOT NULL
  `
  const net = toMoney(row?.net ?? null).abs()

  const computed = await computePeriod(period)
  const turnover = toMoney(computed.boxes.totalValueSalesExVAT)
  const onePercent = turnover.times(settings.error_threshold_percent).dividedBy(100)

  // The greater of the fixed figure and the percentage, capped.
  const threshold = Prisma.Decimal.max(
    toMoney(settings.error_threshold_fixed),
    onePercent,
  )
  const capped = Prisma.Decimal.min(threshold, toMoney(settings.error_threshold_cap))

  return {
    net: formatMoney(net),
    threshold: formatMoney(capped),
    overThreshold: net.greaterThan(capped),
    cap: formatMoney(settings.error_threshold_cap),
    boxSixTurnover: formatMoney(turnover),
  }
}

// ---------------------------------------------------------------------------
// The gate submission opens with
// ---------------------------------------------------------------------------

export type FinalisedComparison = {
  matches: boolean
  frozen: VatBoxes | null
  current: VatBoxes
  differences: { box: string; frozen: string; current: string }[]
}

/**
 * Recompute and compare against what was frozen at finalise.
 *
 * This is the digital-links guarantee, and the reason a submission cannot
 * quietly send something other than what the owner approved: any difference at
 * all aborts, and the screen shows which figures moved.
 */
export async function compareWithFinalisedSnapshot(
  period: BkVatPeriodRow,
): Promise<FinalisedComparison> {
  const computed = await computePeriod(period)
  const snapshots = await listSnapshots(period.id)
  const frozen = [...snapshots].reverse().find((s) => s.kind === 'finalised')?.boxes ?? null

  if (!frozen) {
    return { matches: false, frozen: null, current: computed.boxes, differences: [] }
  }

  const differences = (Object.keys(computed.boxes) as (keyof VatBoxes)[])
    .filter((key) => computed.boxes[key] !== frozen[key])
    .map((key) => ({ box: key, frozen: frozen[key], current: computed.boxes[key] }))

  return {
    matches: boxesMatch(frozen, computed.boxes),
    frozen,
    current: computed.boxes,
    differences,
  }
}

/** Wording for the emailed receipt and the screen. */
export function describeNetVat(boxes: VatBoxes): string {
  const direction = netVatDirection(boxes)
  if (direction === 'nil') return 'nothing to pay or reclaim'
  return `${formatPounds(boxes.netVatDue)} to ${direction === 'pay' ? 'pay' : 'reclaim'}`
}

export { getChainHead }
