import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getFolderTrail, getOrCreateFolderByPath, moveOrRenameMedia } from '@/lib/media/organise'
import {
  FILING_ROOT,
  filingFilename,
  filingFolderNames,
  kindForDocument,
  kindForTransaction,
  type FilingKind,
  type FilingNameParts,
} from './filing'

// Putting a document where it belongs, after the fact.
//
// Two things call this. A person correcting what we read off a receipt - which
// is the moment "is this a sale or a purchase" and "what is its number" stop
// being guesses - and the one-off sweep that walks everything filed before the
// folders existed. Both want the same answer to the same question, so both ask
// it here.
//
// Every move goes through core's moveOrRenameMedia, which relocates the blob,
// updates the library row and rewrites every reference to the old address -
// including this module's own attachment rows, via the media-reference-rewriter
// extension. Doing it by hand would repoint the row and leave the bytes.
//
// ONE RULE ABOVE ALL, and it is the reason this file is careful rather than
// clever: a document is only moved if its file already lives under Bookkeeping.
// A supplier's bill that arrived from the purchase-orders module is that
// module's file, sitting in that module's folder, recorded in that module's own
// table - and that table has no rewriter of its own to follow a move. Filing it
// into our cabinet would leave them holding an address that no longer answers.

/** How many files one sweep will move before handing back a cursor. */
const DEFAULT_BATCH = 25
const MAX_BATCH = 50

type FilingCandidate = {
  id: string
  media_id: string | null
  filename: string
  created_at: Date
  guessed_direction: 'income' | 'expense' | null
  guessed_counterparty: string | null
  guessed_document_number: string | null
  guessed_document_date: Date | null
  t_direction: 'income' | 'expense' | null
  t_entry_type: string | null
  t_corrects: string | null
  t_counterparty: string | null
  t_reference: string | null
  t_tax_point_date: Date | null
}

const CANDIDATES = Prisma.sql`
  SELECT
    a."id", a."media_id", a."filename", a."created_at",
    a."guessed_direction", a."guessed_counterparty", a."guessed_document_number",
    a."guessed_document_date",
    t."direction"               AS t_direction,
    t."entry_type"              AS t_entry_type,
    t."corrects_transaction_id" AS t_corrects,
    t."counterparty"            AS t_counterparty,
    t."reference"               AS t_reference,
    t."tax_point_date"          AS t_tax_point_date
  FROM "bk_attachments" a
  LEFT JOIN "bk_transactions" t ON t."id" = a."transaction_id"
`

/**
 * Where this document ought to live, or null when nothing is known well enough
 * to say.
 *
 * The entry wins wherever there is one: it is a fact somebody typed and saved,
 * and what the reader made of the paper is a guess. With no entry the reading is
 * all there is, and a reading that never worked out which way the money went
 * yields no answer at all - which is the right answer, because a document filed
 * into the wrong drawer confidently is worse than one still in the tray.
 */
export function plannedFiling(row: FilingCandidate): {
  kind: FilingKind
  date: Date
  parts: FilingNameParts
} | null {
  if (row.t_direction) {
    return {
      kind: kindForTransaction({
        direction: row.t_direction,
        entry_type: row.t_entry_type,
        corrects_transaction_id: row.t_corrects,
      }),
      date: row.t_tax_point_date ?? row.created_at,
      parts: { counterparty: row.t_counterparty, documentNumber: row.t_reference },
    }
  }

  const kind = kindForDocument(row.guessed_direction)
  if (!kind) return null
  return {
    kind,
    date: row.guessed_document_date ?? row.created_at,
    parts: {
      counterparty: row.guessed_counterparty,
      documentNumber: row.guessed_document_number,
    },
  }
}

/**
 * Is this file one of ours to move?
 *
 * True only when it already sits somewhere under the Bookkeeping tree. See the
 * note at the top of the file: everything else belongs to whoever put it there.
 * A file in the library root is not ours either - it was dropped in by hand.
 */
async function isOursToMove(
  folderId: string | null,
  trailCache: Map<string, boolean>,
): Promise<boolean> {
  if (!folderId) return false
  const cached = trailCache.get(folderId)
  if (cached !== undefined) return cached
  const trail = await getFolderTrail(folderId)
  const ours = trail[0]?.name === FILING_ROOT
  trailCache.set(folderId, ours)
  return ours
}

export type RefileOutcome =
  | { moved: true; from: string; to: string }
  | { moved: false; reason: string }

/**
 * Move one document's file to where the filing scheme says it goes.
 *
 * Never throws. It is called from the middle of saving a correction, and a
 * bookkeeping record must not fail to save because a file store was busy - the
 * record is the thing that matters, and the next sweep picks the move up.
 */
export async function refileAttachment(attachmentId: string): Promise<RefileOutcome> {
  const rows = await prisma.$queryRaw<FilingCandidate[]>`
    ${CANDIDATES} WHERE a."id" = ${attachmentId} LIMIT 1
  `
  const row = rows[0]
  if (!row) return { moved: false, reason: 'There is no such document.' }
  return refileOne(row, new Map())
}

async function refileOne(
  row: FilingCandidate,
  trailCache: Map<string, boolean>,
): Promise<RefileOutcome> {
  if (!row.media_id) {
    return { moved: false, reason: 'That file is not in the media library, so there is nothing to move.' }
  }

  const planned = plannedFiling(row)
  if (!planned) {
    return { moved: false, reason: 'Nothing yet says whether that one is money in or money out.' }
  }

  try {
    const media = await prisma.media.findUnique({
      where: { id: row.media_id },
      select: { id: true, folderId: true, originalName: true },
    })
    if (!media) {
      return { moved: false, reason: 'That file is no longer in the media library.' }
    }
    if (!(await isOursToMove(media.folderId, trailCache))) {
      return {
        moved: false,
        reason: 'That file lives outside the Bookkeeping folders, so it belongs to whatever put it there.',
      }
    }

    const targetFolderId = await getOrCreateFolderByPath(
      filingFolderNames(planned.date, planned.kind),
    )
    // The name it arrived under is the fallback, exactly as it is on upload: a
    // receipt with no supplier and no number keeps the name a person recognises
    // rather than being renamed to nothing.
    const targetName =
      filingFilename(planned.kind, planned.parts, media.originalName ?? row.filename) ??
      media.originalName ??
      row.filename

    if (media.folderId === targetFolderId && media.originalName === targetName) {
      return { moved: false, reason: 'Already filed where it belongs.' }
    }

    const from = media.originalName ?? row.filename
    await moveOrRenameMedia(media.id, {
      targetFolderId,
      newName: targetName,
      // A second invoice genuinely numbered the same as an existing one is a
      // thing that happens across suppliers. Suffixing keeps both; erroring
      // would stop the sweep dead on one awkward pair, and replacing would
      // destroy a piece of evidence.
      collision: 'suffix',
      exactName: true,
    })
    return { moved: true, from, to: targetName }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not re-file a document:', message)
    return { moved: false, reason: message.replace(/\s+/g, ' ').trim().slice(0, 200) }
  }
}

export type RefileSweep = {
  examined: number
  moved: number
  skipped: number
  /** Pass back as `after` to carry on. Null when there is nothing left to look at. */
  cursor: string | null
  /** The first few moves, so the screen can show what actually happened. */
  examples: { from: string; to: string }[]
  /** Anything that could not be moved and is worth a person seeing. */
  problems: string[]
}

/**
 * Walk the documents already filed and move each one into the folder scheme.
 *
 * Batched and resumable rather than one long pass: every move copies a file in
 * storage, and a few hundred receipts would run a serverless function well past
 * its ceiling. The cursor is the attachment id it stopped at, which is stable -
 * a row cannot move under it, because the order is by id.
 *
 * Idempotent. A file already where it belongs is compared, found to match, and
 * left alone, so running this twice costs a query and nothing else.
 */
export async function sweepFiling(options: { after?: string | null; limit?: number } = {}): Promise<RefileSweep> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_BATCH, 1), MAX_BATCH)
  const after = options.after?.trim() || ''

  const rows = await prisma.$queryRaw<FilingCandidate[]>`
    ${CANDIDATES}
    WHERE a."media_id" IS NOT NULL
      AND (${after}::text = '' OR a."id" > ${after}::text)
    ORDER BY a."id" ASC
    LIMIT ${limit}
  `

  const trailCache = new Map<string, boolean>()
  const sweep: RefileSweep = {
    examined: rows.length,
    moved: 0,
    skipped: 0,
    cursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    examples: [],
    problems: [],
  }

  for (const row of rows) {
    const outcome = await refileOne(row, trailCache)
    if (outcome.moved) {
      sweep.moved += 1
      if (sweep.examples.length < 5) sweep.examples.push({ from: outcome.from, to: outcome.to })
    } else {
      sweep.skipped += 1
      // "Already filed where it belongs" and "nothing says what it is" are the
      // two ordinary answers and are not problems. Everything else is.
      if (
        !outcome.reason.startsWith('Already filed') &&
        !outcome.reason.startsWith('Nothing yet says') &&
        sweep.problems.length < 5 &&
        !sweep.problems.includes(outcome.reason)
      ) {
        sweep.problems.push(outcome.reason)
      }
    }
  }

  return sweep
}
