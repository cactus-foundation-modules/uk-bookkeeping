import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit, getChainHead, nextChainLink, chainHash } from './audit'
import { BookkeepingError, NotFoundError, PeriodStateError, RecordsChangedError } from './errors'
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
  // Due DATES are inclusive: HMRC accepts a return all the way to the end of
  // the due day, so overdue starts the day after, not at midnight as it turns.
  const endOfDueDay = period.due_date.getTime() + 24 * 60 * 60 * 1000
  return endOfDueDay <= Date.now()
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

/**
 * Month arithmetic anchored to a fixed date, clamped to the month's length.
 *
 * setUTCMonth rolls over - 31 Jan + 1 month is 3 March - so iterating with it
 * skews every boundary after a short month whenever the first period starts on
 * the 29th, 30th or 31st. Anchoring each period at `first + i * months` and
 * clamping the day keeps 31 Jan → 28 Feb → 31 Mar → 30 Apr, which is what a
 * calendar means by "a month later".
 */
function addMonthsClamped(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth() + months
  const day = anchor.getUTCDate()
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTarget)))
}

function monthsPerPeriod(frequency: PeriodFrequency): number {
  return frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12
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
  const months = monthsPerPeriod(frequency)
  const anchor = new Date(settings.first_period_start)
  const horizon = addMonthsClamped(new Date(), months)

  // Each period is anchored to the first start rather than iterated from the
  // previous end, so a short month cannot skew every boundary after it.
  // A guard rather than a `while (true)`: a first-period-start set to 1970 by
  // accident should produce a refusal, not four hundred rows.
  const starts: string[] = []
  const ends: string[] = []
  for (let i = 0; i < 200; i += 1) {
    const start = addMonthsClamped(anchor, i * months)
    if (start > horizon) break
    const end = new Date(addMonthsClamped(anchor, (i + 1) * months).getTime() - 24 * 60 * 60 * 1000)
    starts.push(toDateOnly(start))
    ends.push(toDateOnly(end))
  }

  // One statement, ON CONFLICT, so two simultaneous calls cannot race the
  // SELECT-then-INSERT into a raw unique violation. A candidate that overlaps
  // an existing period with a DIFFERENT range - usually one HMRC issued - is
  // skipped rather than doubled up: two open periods claiming the same rows
  // means every figure counted twice.
  const created: string[] = []
  if (starts.length > 0) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "bk_vat_periods" ("start_date", "end_date", "scheme", "source", "vrn")
      SELECT c.start_date, c.end_date, ${settings.scheme}, 'local', ${settings.vrn}
      FROM unnest(${starts}::date[], ${ends}::date[]) AS c(start_date, end_date)
      WHERE NOT EXISTS (
        SELECT 1 FROM "bk_vat_periods" p
        WHERE p."start_date" <= c.end_date AND p."end_date" >= c.start_date
          AND NOT (p."start_date" = c.start_date AND p."end_date" = c.end_date)
      )
      ON CONFLICT ("start_date", "end_date") DO NOTHING
      RETURNING "id"
    `
    created.push(...rows.map((r) => r.id))
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

type PeriodRange = Pick<BkVatPeriodRow, 'id' | 'scheme' | 'start_date' | 'end_date'>

/**
 * Membership of a period, as a WHERE fragment over alias t. The same rule as
 * vat-boxes.ts's membership: the period's OWN scheme decides which date column
 * claims a transaction.
 */
function periodMembership(period: PeriodRange): Prisma.Sql {
  return Prisma.sql`
    t."status" = 'posted'
    AND (
      (${period.scheme}::text = 'accrual'
        AND t."tax_point_date" BETWEEN ${period.start_date}::date AND ${period.end_date}::date)
      OR (${period.scheme}::text = 'cash' AND t."settled_date" IS NOT NULL
        AND t."settled_date" BETWEEN ${period.start_date}::date AND ${period.end_date}::date)
    )
  `
}

/** Every transaction whose lines land in this period, under this period's scheme. */
async function contributingTransactionIds(
  period: BkVatPeriodRow,
  db: Pick<typeof prisma, '$queryRaw' | '$executeRaw'> = prisma,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT t."id"
    FROM "bk_transactions" t
    JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE ${periodMembership(period)}
  `
  return rows.map((r) => r.id)
}

/**
 * Imported rows still awaiting review, which must be dealt with before filing.
 * A draft counts when it WOULD belong to this period once posted - by the
 * period's own scheme, not just by tax point.
 */
async function countDraftsInRange(
  period: BkVatPeriodRow,
  db: Pick<typeof prisma, '$queryRaw' | '$executeRaw'> = prisma,
): Promise<number> {
  const [row] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_transactions" t
    WHERE t."status" = 'draft'
      AND (
        (${period.scheme}::text = 'accrual'
          AND t."tax_point_date" BETWEEN ${period.start_date}::date AND ${period.end_date}::date)
        OR (${period.scheme}::text = 'cash' AND t."settled_date" IS NOT NULL
          AND t."settled_date" BETWEEN ${period.start_date}::date AND ${period.end_date}::date)
      )
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
  // The chain head is read ON THE CALLER'S TRANSACTION, so the FOR UPDATE it
  // takes really does serialise two concurrent snapshot writers instead of
  // evaporating in autocommit on some other pooled connection.
  const { chainIndex, prevHash } = await nextChainLink('bk_period_snapshots', tx)
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

  // One statement for all lines. PgBouncer wraps every statement in its own
  // round trips, so a loop here would cost four per line on a busy quarter.
  if (input.lines.length > 0) {
    const transactionIds = input.lines.map((l) => l.transactionId)
    const lineIds = input.lines.map((l) => l.lineId)
    const directions = input.lines.map((l) => l.direction)
    const treatments = input.lines.map((l) => l.vatTreatment)
    const rateCodes = input.lines.map((l) => l.vatRateCode)
    const nets = input.lines.map((l) => l.netAmount)
    const vats = input.lines.map((l) => l.vatAmount)
    const boxes = input.lines.map((l) => JSON.stringify(l.boxes))
    await tx.$executeRaw`
      INSERT INTO "bk_period_snapshot_lines" (
        "snapshot_id", "transaction_id", "line_id", "direction", "vat_treatment",
        "vat_rate_code", "net_amount", "vat_amount", "boxes"
      )
      SELECT ${snapshotId}, c.transaction_id, c.line_id, c.direction, c.vat_treatment,
             c.vat_rate_code, c.net_amount, c.vat_amount, c.boxes
      FROM unnest(
        ${transactionIds}::text[], ${lineIds}::text[], ${directions}::text[],
        ${treatments}::text[], ${rateCodes}::text[],
        ${nets}::numeric[], ${vats}::numeric[], ${boxes}::jsonb[]
      ) AS c(transaction_id, line_id, direction, vat_treatment, vat_rate_code,
             net_amount, vat_amount, boxes)
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

  const settings = await getSettings()

  // Everything - the claim, the draft check, the computation, the snapshot and
  // the row tagging - happens inside ONE repeatable-read transaction. The claim
  // comes first so two concurrent finalises cannot both pass the status check,
  // and repeatable read means the snapshot and the tagged row set are cut from
  // the same instant rather than drifting while a colleague keeps typing.
  const result = await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "bk_vat_periods"
        SET "status" = 'finalised', "finalised_at" = NOW(),
            "finalised_by_user_id" = ${user?.id ?? null}, "updated_at" = NOW()
        WHERE "id" = ${period.id} AND "status" = 'open'
      `
      if (claimed === 0) {
        throw new PeriodStateError('That return has just been finalised or filed by somebody else.')
      }

      const drafts = await countDraftsInRange(period, tx)
      if (drafts > 0) {
        throw new PeriodStateError(
          `There ${drafts === 1 ? 'is' : 'are'} still ${drafts} imported entr${drafts === 1 ? 'y' : 'ies'} in this period waiting to be reviewed. Deal with those first, then finalise.`,
        )
      }

      const computed = await computeVatReturn(
        period.start_date,
        period.end_date,
        period.scheme,
        settings.box_rounding,
        tx,
      )
      const contributing = await contributingTransactionIds(period, tx)

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
      return { computed, contributing }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )

  await appendAudit({
    action: 'period.finalised',
    entityType: 'vat_period',
    entityId: period.id,
    summary: `VAT return for ${toDateOnly(period.start_date)} to ${toDateOnly(period.end_date)} finalised`,
    detail: { boxes: result.computed.boxes, transactions: result.contributing.length },
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
    // The claim first: a submission may be mid-flight in another request, and
    // its recordSubmission must not find the period quietly reopened under it.
    const claimed = await tx.$executeRaw`
      UPDATE "bk_vat_periods"
      SET "status" = 'open', "finalised_at" = NULL, "finalised_by_user_id" = NULL, "updated_at" = NOW()
      WHERE "id" = ${period.id} AND "status" = 'finalised'
    `
    if (claimed === 0) {
      throw new PeriodStateError('That return has just been filed, so it can no longer be reopened.')
    }
    // The snapshot stays. It is append-only, and it is now the evidence of what
    // the numbers were before somebody changed their mind.
    await tx.$executeRaw`
      UPDATE "bk_transactions" SET "finalised_period_id" = NULL, "updated_at" = NOW()
      WHERE "finalised_period_id" = ${period.id} AND "locked_period_id" IS NULL
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
 * The rows locked are the period's rows BY MEMBERSHIP - the same date-and-scheme
 * rule that decides the figures - not whatever happened to be tagged
 * finalised_period_id at finalise time. Locking by the tag left a hole: any row
 * that joined the period after finalise (or had its tag cleared by an
 * unfinalise racing the submission) was written into the immutable snapshot yet
 * left editable. Membership is recomputed here, inside the submitting
 * transaction, so what is snapshotted and what is locked cannot be two
 * different sets.
 *
 * Called last within the submitting transaction, after the receipt is stored,
 * because a crash between the two states must leave a period that is
 * submitted-and-unlocked (recoverable, and visible to a consistency check)
 * rather than locked-with-no-receipt, which is a mystery.
 */
export async function lockPeriodRecords(
  tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  period: PeriodRange,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "bk_transaction_lines" SET "locked_period_id" = ${period.id}, "updated_at" = NOW()
    WHERE "locked_period_id" IS NULL AND "transaction_id" IN (
      SELECT t."id" FROM "bk_transactions" t WHERE ${periodMembership(period)}
    )
  `
  await tx.$executeRaw`
    UPDATE "bk_attachments" SET "locked_period_id" = ${period.id}
    WHERE "locked_period_id" IS NULL AND "transaction_id" IN (
      SELECT t."id" FROM "bk_transactions" t WHERE ${periodMembership(period)}
    )
  `
  await tx.$executeRaw`
    UPDATE "bk_transactions" SET
      "locked_period_id" = ${period.id}, "locked_at" = NOW(),
      "finalised_period_id" = ${period.id}, "updated_at" = NOW()
    WHERE "locked_period_id" IS NULL AND "id" IN (
      SELECT t."id" FROM "bk_transactions" t WHERE ${periodMembership(period)}
    )
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

  const settings = await getSettings()

  const boxes = await prisma.$transaction(
    async (tx) => {
      // Claim before anything else: two concurrent marks, or a mark racing the
      // HMRC submit, must resolve to exactly one winner.
      const claimed = await tx.$executeRaw`
        UPDATE "bk_vat_periods"
        SET "submitted_externally" = TRUE, "submitted_at" = NOW(),
            "submitted_by_user_id" = ${user?.id ?? null}, "updated_at" = NOW()
        WHERE "id" = ${period.id} AND "status" = 'finalised'
      `
      if (claimed === 0) {
        throw new PeriodStateError('That return has just been filed or reopened by somebody else.')
      }

      const computed = await computeVatReturn(
        period.start_date,
        period.end_date,
        period.scheme,
        settings.box_rounding,
        tx,
      )

      // The same gate the HMRC path has: what is recorded as filed must be the
      // figures that were frozen at finalise. If the records moved since, the
      // owner filed something else elsewhere, and that wants looking at - not
      // silently snapshotting numbers nobody approved.
      const [frozen] = await tx.$queryRaw<{ boxes: VatBoxes }[]>`
        SELECT "boxes" FROM "bk_period_snapshots"
        WHERE "period_id" = ${period.id} AND "kind" = 'finalised'
        ORDER BY "chain_index" DESC LIMIT 1
      `
      if (!frozen || !boxesMatch(frozen.boxes, computed.boxes)) {
        throw new RecordsChangedError()
      }

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
      await lockPeriodRecords(tx, period)
      await tx.$executeRaw`
        UPDATE "bk_vat_periods" SET "status" = 'submitted', "updated_at" = NOW()
        WHERE "id" = ${period.id} AND "status" = 'finalised'
      `
      return computed.boxes
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )

  await appendAudit({
    action: 'period.marked-submitted-elsewhere',
    entityType: 'vat_period',
    entityId: period.id,
    summary: `VAT return for ${toDateOnly(period.start_date)} to ${toDateOnly(period.end_date)} recorded as filed elsewhere`,
    detail: { boxes },
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
  /** The full recomputation behind `current`, so a submission can snapshot the
   * workings computed BEFORE the network call rather than re-reading the tables
   * after HMRC has already accepted. */
  computation: Awaited<ReturnType<typeof computePeriod>>
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
    return {
      matches: false,
      frozen: null,
      current: computed.boxes,
      differences: [],
      computation: computed,
    }
  }

  const differences = (Object.keys(computed.boxes) as (keyof VatBoxes)[])
    .filter((key) => computed.boxes[key] !== frozen[key])
    .map((key) => ({ box: key, frozen: frozen[key], current: computed.boxes[key] }))

  return {
    matches: boxesMatch(frozen, computed.boxes),
    frozen,
    current: computed.boxes,
    differences,
    computation: computed,
  }
}

/** Wording for the emailed receipt and the screen. */
export function describeNetVat(boxes: VatBoxes): string {
  const direction = netVatDirection(boxes)
  if (direction === 'nil') return 'nothing to pay or reclaim'
  return `${formatPounds(boxes.netVatDue)} to ${direction === 'pay' ? 'pay' : 'reclaim'}`
}

export { getChainHead }
