<p align="center">
  <img src="module-art.webp" alt="Cactus UK Bookkeeping Module" width="640" />
</p>

# Cactus UK Bookkeeping Module

UK bookkeeping with double-entry accounts, Making Tax Digital VAT returns and
corporation tax, for [Cactus](https://github.com/usersaynoso/cactus-foundation).

Records income and expenses with their evidence attached, keeps one proper set of
books behind them, and works the answers out from those records: the nine VAT
boxes, a profit and loss account, a balance sheet, and a company tax computation
with the CT600 box numbers beside each figure. No VAT box value is ever typed by
a human at any point, in any code path - which is the whole reason the module
exists in this shape, and what the digital links requirement asks for. The tax
computation follows the same rule.

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
- **One set of books.** The cashbook and the journals are the same ledger. Each
  posted entry is projected into the debits and credits it always implied - the
  cost, the VAT, the debtor or creditor it raised, and the money when it moved -
  and that is unioned with the journal lines. Every report reads it, so there is
  exactly one answer to "what is the balance on this account". It is computed,
  never stored: a second copy would have to stay in step with rows that go
  hard-locked the moment a VAT return is filed, and any drift would be silent.
- **Reports.** A profit and loss account in the statutory shape, with last year
  beside it. A balance sheet that says so when it does not balance. A trial
  balance. The full history of any single account, with a running balance, one
  click from any figure on any statement. Aged debtors and creditors. A
  month-by-month view, a category summary, an SA103 grouping for a sole trader,
  and a full export of everything as spreadsheet files - entries, lines,
  evidence, periods, the frozen figures and workings of every filed return, the
  HMRC call log, and the history log.
- **Financial years.** Not the same thing as a VAT quarter and not required to
  line up with one. Closing a year posts the journal that takes the profit to
  reserves and freezes the year; reopening it takes both back, because an
  accountant finding something in March that belongs to December is ordinary
  rather than an emergency.
- **Equipment and assets.** A register that answers two questions from one row.
  For the accounts, depreciation - straight line or reducing balance, pro-rated
  by the days the thing was actually owned, posted as an ordinary journal. For
  the tax, which capital allowances pool the spend goes in. Keeping them
  together is what stops the two drifting apart.
- **Corporation tax.** The profit in the accounts, the add-backs (depreciation
  and client entertaining come off the accounts themselves; anything else is a
  named adjustment with a reason attached), capital allowances from the register,
  losses brought forward, and the rates - small profits, main, and marginal
  relief, apportioned across the financial years the period touches and divided
  between associated companies. A period of account over twelve months is split
  into two tax periods, because that is what it is. Every CT600 box number, with
  the figure to put in it.
- **Bank import.** Statements as **PDF or CSV**. A PDF downloaded from online
  banking is read by finding the table the way a person would - by where the
  columns sit - so a bank the module has never seen still works, and no PDF
  library is needed to do it. What the statement says about its own totals and
  running balance is checked against what was read, and shown to you, before
  anything is written. A scan or a photograph of a paper statement is refused in
  plain words rather than guessed at.
  Importing keeps the bank's lines and stops there: you are never asked what two
  hundred of them were for before a single one is saved, because that is the job
  nobody finishes, and an import abandoned halfway has kept nothing at all.
- **Reconciliation.** Where a statement is turned into a set of books. The bank's
  own lines are kept as the bank wrote them, and each is either tied to the
  entries that explain it or still open - and it is only ticked off when the match
  accounts for all of it, to the penny. Anything already recorded is offered
  against the entry it matches, with the reason it was offered, rather than
  entered a second time. Anything not recorded yet becomes an entry from the line
  itself: the date, the name and the amount come off the bank's own line, so the
  only thing to supply is what it was for. And the same three things work on a
  selection - search for what the bank prints on your director's loan payments,
  tick the lot, code them in one go. One line that will not take the coding comes
  back as a sentence beside its own row and never strands the rest. Nothing
  reaches a VAT box until a human has said what it was for.
- **Card payouts, less the fees.** A card processor does not pay you what you
  invoiced: GoCardless and Square batch a day's takings into one payout, take
  their cut out of the middle, and net any refunds off as well - so the bank line
  matches no invoice, and no set of invoices, to the penny. Pick the ones the
  payout covers and the difference is recorded as the expense it actually is, on
  the bank and card charges category, exempt from VAT because a merchant fee is.
  The sums are kept honest by the schema rather than by hope: matches carry a
  signed amount, so six invoices plus a refund plus the fee add up to exactly what
  arrived, and a settlement that does not add up is refused outright rather than
  half applied.
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

## Testing the ledger against a real database

The rules that make double entry mean anything - a posted journal balances, a
filed journal cannot be rewritten, one statement line cannot be imported twice -
are enforced by database triggers, and a trigger that does not fire looks exactly
like one that does until the day it matters. The posting projection is SQL for
the same reason, and if it is wrong then the profit and loss account, the balance
sheet and the tax computation are all wrong in the same direction at once. So
both are tested against a real Postgres rather than in memory:

```bash
npm run test:ledger-guards
```

It provisions its own throwaway databases on the configured server, applies every
migration in order, tries to break each rule, and drops everything afterwards. It
also re-runs every migration a second time, which is what an install update does.

The projection tests check the figures - an unpaid sale in debtors, VAT parked
until payment under cash accounting, a dividend as equity rather than a cost -
and then check the thing that matters more than any of them: that total debits
equal total credits, whatever is thrown at it.

The tax arithmetic needs no database and runs in the ordinary suite: financial
year boundaries, splitting a long period of account, marginal relief, associated
companies halving the thresholds, and each capital allowances pool.

## What it is not

Not payroll, not stock, not invoicing your customers. Not the Flat Rate Scheme,
partial exemption, margin schemes or bad debt relief. Not MTD for Income Tax. One
VAT registration per site. It does not work out anybody's personal tax, including
on a director's loan - it shows the position and points at an accountant.

**It does not file a corporation tax return.** There is no HMRC API a small
company can self-file corporation tax through, the way there is for VAT; filing
goes through HMRC's own online service or commercial software. What the module
produces is the computation and the box numbers to copy across.

The computation deliberately leaves several things alone rather than
half-implementing them: research and development relief, patent box, group relief
arithmetic, ring fence trades, Northern Ireland rates, loans to participators,
structures and buildings allowance, and the super-deduction. Each has its own
supplementary pages and its own specialism, and a half-answer would look like an
answer. Every one of them can still be entered as a named adjustment, which puts
it on the computation with a reason attached and leaves the arithmetic to whoever
knows it.

There is no virus scanning on uploaded evidence, here or anywhere else in Cactus.
Files are stored, not executed, served as downloads, and checked against their
actual bytes rather than their name. That is the extent of it.

## License

MIT
