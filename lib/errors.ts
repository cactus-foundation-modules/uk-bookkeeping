// Errors the service layer throws, and the one place that turns them into a
// response. Each carries a sentence a site owner can act on, because most of
// them are refusals rather than faults - "you cannot do that, here is what to do
// instead" - and a stack trace is no use to anybody reading it.

export class BookkeepingError extends Error {
  readonly status: number
  readonly code: string

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'BookkeepingError'
    this.code = code
    this.status = status
  }
}

export class NotFoundError extends BookkeepingError {
  constructor(what: string) {
    super('not_found', `${what} could not be found.`, 404)
  }
}

export class LockedRecordError extends BookkeepingError {
  constructor(id: string, periodId: string) {
    super(
      'locked',
      `Transaction ${id} was included in a VAT return that has been submitted to HMRC (period ${periodId}), so it cannot be changed. Post a correction in the current open period instead.`,
      409,
    )
  }
}

export class FinalisedRecordError extends BookkeepingError {
  constructor(id: string, periodId: string) {
    super(
      'finalised',
      `Transaction ${id} is part of a VAT return that has been finalised but not yet submitted. Unfinalise that return first if you need to change this.`,
      409,
    )
  }
}

export class BackdatedIntoClosedPeriodError extends BookkeepingError {
  constructor(periodId: string) {
    super(
      'backdated',
      `That date falls inside a VAT period that has already been finalised or filed (period ${periodId}). Record it in the current open period as a correction instead.`,
      409,
    )
  }
}

export class PeriodStateError extends BookkeepingError {
  constructor(message: string) {
    super('period_state', message, 409)
  }
}

export class RecordsChangedError extends BookkeepingError {
  constructor() {
    super(
      'records_changed',
      'The records changed after this return was finalised, so what would be sent no longer matches what was frozen. Unfinalise it, review the figures, and finalise again.',
      409,
    )
  }
}

export class HmrcNotConfiguredError extends BookkeepingError {
  constructor() {
    super(
      'hmrc_not_configured',
      'This site has no HMRC credentials yet, so it cannot talk to HMRC. Everything else in Bookkeeping still works.',
      503,
    )
  }
}

export class HmrcReauthRequiredError extends BookkeepingError {
  constructor(detail?: string) {
    super(
      'hmrc_reauth_required',
      `The connection to HMRC has expired and needs setting up again.${detail ? ` (${detail})` : ''}`,
      409,
    )
  }
}

/** An error HMRC itself returned, kept with its own code so the UI can branch. */
export class HmrcApiError extends BookkeepingError {
  readonly hmrcCode: string
  readonly correlationId: string | null
  readonly httpStatus: number

  constructor(input: {
    hmrcCode: string
    message: string
    httpStatus: number
    correlationId?: string | null
  }) {
    super('hmrc_api', input.message, 502)
    this.name = 'HmrcApiError'
    this.hmrcCode = input.hmrcCode
    this.httpStatus = input.httpStatus
    this.correlationId = input.correlationId ?? null
  }
}

/** Anything unexpected becomes a 500 with a generic sentence; ours keep theirs. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof BookkeepingError) {
    const body: Record<string, unknown> = { error: error.message, code: error.code }
    if (error instanceof HmrcApiError) {
      body.hmrcCode = error.hmrcCode
      body.correlationId = error.correlationId
    }
    return Response.json(body, { status: error.status })
  }
  // A trigger firing looks like a plain database error, so translate the one
  // message a site owner could otherwise meet raw.
  const message = error instanceof Error ? error.message : ''
  if (/submitted VAT return|append-only/i.test(message)) {
    return Response.json({ error: message, code: 'locked' }, { status: 409 })
  }
  return Response.json(
    { error: 'Something went wrong saving that. Nothing has been changed.', code: 'internal' },
    { status: 500 },
  )
}
