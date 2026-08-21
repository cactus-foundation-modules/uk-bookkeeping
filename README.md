# Cactus UK Bookkeeping Module

UK bookkeeping with Making Tax Digital VAT returns, for
[Cactus](https://github.com/usersaynoso/cactus-foundation).

Records income and expenses with their evidence attached, works the nine VAT
boxes out from those records, and files them with HMRC. No box value is ever
typed by a human at any point, in any code path - which is the whole reason the
module exists in this shape, and what the digital links requirement asks for.

## What it does

- **Overview.** Where the VAT stands right now, when the next return is due and
  how many days remain, this month's money in and out, what is waiting for
  review, and the latest entries - each figure linking to the screen it can be
  acted on.
- **Records.** Entries with a date, a counterparty and one or more lines, so a
  single receipt can split across categories and VAT rates. A UK chart of
  categories is seeded and can be extended. The form suggests counterparties the
  site has seen before and pre-picks the category their entries usually land in.
- **Evidence.** Receipts and invoices attached to an entry, stored through the
  site's own media provider and never tidied away by the media clean-up.
- **VAT returns.** Periods, the nine boxes computed in one SQL statement,
  each expandable to the exact entries behind it, and a frozen snapshot of both
  the figures and the workings at the moment you finalise. HMRC's declaration is
  shown and affirmed before anything is sent, and the periods screen can show
  what HMRC says is owed and paid, beside your own figures.
- **HMRC.** OAuth to the Government Gateway, obligations, liabilities, payments,
  and submission with the fraud prevention headers HMRC requires. Absent
  credentials, everything except filing still works.
- **Reports.** Category summary, profit and loss, a month-by-month view, a
  grouping for SA103 or CT600, and a full export of everything as spreadsheet
  files - entries, lines, evidence, periods, the frozen figures and workings of
  every filed return, the HMRC call log, and the history log.
- **Bank import.** Statements as **PDF or CSV**. A PDF downloaded from online
  banking is read by finding the table the way a person would - by where the
  columns sit - so a bank the module has never seen still works, and no PDF
  library is needed to do it. What the statement says about its own totals and
  running balance is checked against what was read, and shown to you, before
  anything is written. A scan or a photograph of a paper statement is refused in
  plain words rather than guessed at.
- **Reconciliation.** The bank's own lines are kept as the bank wrote them, and
  each is either tied to the entries that explain it or still open - and it is
  only ticked off when the match accounts for all of it, to the penny. Lines that
  are already recorded are offered against the entry they match, with the reason,
  rather than imported a second time. Nothing new reaches a VAT box until a human
  has said what it was for.
- **Journals.** Double entry for the things that are not money moving:
  depreciation, accruals, prepayments, corrections, director money in and out.
  Two sides that have to add up, enforced in the database rather than only in the
  form, with reversal rather than editing once posted. A journal reaches no VAT
  box, ever - anything with VAT on it is a receipt or a sale and belongs with the
  entries.
- **Director's loan account.** What the company owes you, or you owe the company,
  stated in those words rather than as a sign. Fed by both bank transfers and
  journals, with the year-end position, the section 455 date and the benefit-in-
  kind question surfaced in time to do something about them. It reports the
  position; it does not work out anybody's tax.

## Once a return is filed, it locks

Filing a return locks every entry, line and receipt behind it, and there is no
unsubmit path. Corrections are new entries in the current open period, linked to
the original - which is how HMRC expects a mistake on a past return to be put
right.

The lock is enforced in three places: the UI shows no controls, the service layer
refuses, and database triggers refuse. That last one does not stop somebody with
the connection string from switching the triggers off, so the module checks
`pg_trigger` and puts a red banner across every page if any of them is missing or
disabled. That banner is the honest version of "bulletproof".

## Installation

Install the module from the Cactus admin panel under Modules.

## Configuration

Set your business details, VAT number, scheme and filing frequency under
Settings → Bookkeeping. That is enough to start recording and to see every VAT
box worked out; nothing else is needed unless you want to file from here.

To file with HMRC the site needs its own credentials. Cactus is self-hosted, so
there is no shared key to hand out - HMRC issues credentials to the business
running the software. Register an application on HMRC's Developer Hub, subscribe
it to **VAT (MTD)**, and add `HMRC_CLIENT_ID` and `HMRC_CLIENT_SECRET` to your
hosting environment variables.

The redirect URI to register with HMRC is the same on every install:

```
https://<your-domain>/api/m/uk-bookkeeping/hmrc/callback
```

It deliberately does not contain your admin path, so renaming that never breaks
the connection. The settings tab prints the correct one for your site with a copy
button.

Before applying for production access, use **Have HMRC check the details we
send** in the settings tab. It calls HMRC's own fraud prevention header checker
with a real request and reports what they said - which is the evidence their
approval process asks for, available in seconds rather than after a ten working
day wait.

Grant `bookkeeping.access` to whichever roles should see the section,
`bookkeeping.record` to those who record entries, `bookkeeping.submit` to those
who may finalise and file, and `bookkeeping.settings` to those who may change
settings and the HMRC connection.

## Testing against HMRC's sandbox

`modules/uk-bookkeeping/lib/hmrc/sandbox.live.test.ts` probes HMRC's sandbox for
real, gated on `RUN_HMRC_SANDBOX=1` so plain `npm test` never reaches the
network:

```bash
RUN_HMRC_SANDBOX=1 npx vitest run modules/uk-bookkeeping/lib/hmrc/sandbox.live.test.ts
```

Tier one needs no credentials and proves what is ours to get wrong - that every
path is a real resource, and that our Accept header names a version HMRC serve.
An unauthenticated call to a real resource is answered 401; a path that does not
exist is answered 404, and the suite asserts both, so a passing 401 means
something. Tier two runs HMRC's fraud prevention header validator and needs
`HMRC_CLIENT_ID` / `HMRC_CLIENT_SECRET` from a sandbox application.

What neither tier can do is sign in as a Government Gateway test user, so
obligations, submission and viewing a return are checked by hand - there is a
step-by-step list on the wiki page.

## Testing the ledger guards against a real database

The rules that make double entry mean anything - a posted journal balances, a
filed journal cannot be rewritten, one statement line cannot be imported twice -
are enforced by database triggers, and a trigger that does not fire looks exactly
like one that does until the day it matters. So they are tested against a real
Postgres rather than in memory:

```bash
npm run test:ledger-guards
```

It provisions its own throwaway databases on the configured server, applies every
migration in order, tries to break each rule, and drops everything afterwards. It
also re-runs every migration a second time, which is what an install update does.

## What it is not

Not payroll, not stock, not invoicing your customers. Not the Flat Rate Scheme,
partial exemption, margin schemes or bad debt relief. Not MTD for Income Tax. One
VAT registration per site. It does not work out anybody's tax, including on a
director's loan - it shows the position and points at an accountant.

There is no virus scanning on uploaded evidence, here or anywhere else in Cactus.
Files are stored, not executed, served as downloads, and checked against their
actual bytes rather than their name. That is the extent of it.

## License

MIT
