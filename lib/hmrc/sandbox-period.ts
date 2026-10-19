// A test period for the sandbox, made up here.
//
// The sandbox's canned obligations run dry: this module locks a period once it
// is filed, and HMRC's stub hands back the same few again. HMRC's approvals team
// ask for fresh rounds of testing, so a refresh on the sandbox makes sure there
// is always something open to file. Never used against production, where a
// period exists because HMRC says it does.

export type TestPeriod = {
  periodKey: string
  start: string
  end: string
  due: string
}

type Taken = { start: string; end: string; periodKey: string | null }

const pad = (n: number) => String(n).padStart(2, '0')

/** The calendar quarter ending before `today`, stepping back `back` quarters. */
function quarterEndedBefore(today: Date, back: number): { start: string; end: string; endDate: Date } {
  let year = today.getUTCFullYear()
  let quarter = Math.floor(today.getUTCMonth() / 3) // quarter we are in, 0-3
  quarter -= 1 + back
  while (quarter < 0) {
    quarter += 4
    year -= 1
  }
  const startMonth = quarter * 3
  const endDate = new Date(Date.UTC(year, startMonth + 3, 0))
  return {
    start: `${year}-${pad(startMonth + 1)}-01`,
    end: endDate.toISOString().slice(0, 10),
    endDate,
  }
}

/**
 * The most recent finished calendar quarter that is not already a period here,
 * with a `#9nn` key nothing else holds. Finished, because the sandbox refuses a
 * return for a period that has not ended. Due date is the end of the following
 * month plus seven days, as for a real quarter.
 */
export function pickSandboxTestPeriod(taken: Taken[], today = new Date()): TestPeriod | null {
  const ranges = new Set(taken.map((t) => `${t.start}|${t.end}`))
  const keys = new Set(taken.map((t) => t.periodKey).filter((k): k is string => k !== null))

  for (let back = 0; back < 32; back += 1) {
    const quarter = quarterEndedBefore(today, back)
    if (ranges.has(`${quarter.start}|${quarter.end}`)) continue
    for (let n = 900; n <= 999; n += 1) {
      const key = `#${n}`
      if (keys.has(key)) continue
      // The end of the following month, plus seven days.
      const due = new Date(
        Date.UTC(quarter.endDate.getUTCFullYear(), quarter.endDate.getUTCMonth() + 2, 7),
      )
      return { periodKey: key, start: quarter.start, end: quarter.end, due: due.toISOString().slice(0, 10) }
    }
    return null
  }
  return null
}
