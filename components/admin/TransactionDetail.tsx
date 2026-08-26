'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, ErrorNotice, LockedNotice, SandboxBanner } from './Notices'
import DocumentPicker from './DocumentPicker'
import EvidenceDropzone from './EvidenceDropzone'
import { type UnfiledDocument } from './documents-shared'
import TransactionForm, { type TransactionFormValue } from './TransactionForm'
import { formatDate, poundsFromString, toDateInput } from './format'

type Line = {
  id: string
  category_id: string
  description: string
  vat_treatment: string
  vat_rate_code: string
  vat_rate_percent: string
  net_amount: string
  vat_amount: string
  gross_amount: string
  is_capital: boolean
  register_asset: boolean
}

type Attachment = {
  id: string
  name: string
  filename: string
  mime_type: string
  size: number
  locked_period_id: string | null
}

type Transaction = {
  id: string
  entry_type: string
  direction: string
  tax_point_date: string
  settled_date: string | null
  counterparty: string
  description: string
  reference: string | null
  status: string
  bank_account_id: string | null
  evidence_not_required: boolean
  correction_reason: string | null
  corrects_transaction_id: string | null
  finalised_period_id: string | null
  locked_period_id: string | null
  lines: Line[]
  attachments: Attachment[]
  category_names: Record<string, string>
}

export default function TransactionDetail({
  id,
  environment,
  canRecord,
}: {
  id: string
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const [transaction, setTransaction] = useState<Transaction | null>(null)
  const [bankAccountNames, setBankAccountNames] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Bumped after a receipt is filed from here, so the picker drops the one that
  // has just gone. Filing on this screen happens straight away - the entry
  // already exists, so there is nothing to hold anything back for.
  const [pickerKey, setPickerKey] = useState(0)
  const [pickerError, setPickerError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/transactions/${id}`)
      if (!response.ok) {
        setError('That entry could not be found.')
        return
      }
      setTransaction(await response.json())
    } catch {
      setError('That entry could not be loaded. Check the connection and reload the page.')
    }
  }, [id])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  useEffect(() => {
    // Archived ones included: an entry recorded against an account since put
    // away still has to be able to say which one it was.
    fetch('/api/m/uk-bookkeeping/admin/bank-accounts?archived=true')
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((data: { accounts?: { id: string; name: string }[] }) =>
        setBankAccountNames(Object.fromEntries((data.accounts ?? []).map((a) => [a.id, a.name]))),
      )
      .catch(() => setBankAccountNames({}))
  }, [])

  if (error) {
    return (
      <div>
        <BookkeepingNav active="transactions" />
        <ErrorNotice message={error} />
      </div>
    )
  }
  if (!transaction) return <p>Loading…</p>

  const locked = !!transaction.locked_period_id
  const finalised = !locked && !!transaction.finalised_period_id

  async function remove() {
    if (!transaction) return
    if (!window.confirm('Delete this entry? This cannot be undone.')) return
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/transactions/${transaction.id}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That could not be deleted.')
        return
      }
      window.location.href = `/${adminPath}/m/uk-bookkeeping/transactions`
    } catch {
      setError('The delete did not reach the server. Check the connection and try again.')
    }
  }

  async function post() {
    if (!transaction) return
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/transactions/${transaction.id}/post`, {
        method: 'POST',
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That could not be posted.')
        return
      }
      load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    }
  }

  if (editing) {
    const value: TransactionFormValue = {
      id: transaction.id,
      entryType: transaction.entry_type,
      direction: transaction.direction,
      taxPointDate: toDateInput(transaction.tax_point_date),
      settledDate: toDateInput(transaction.settled_date),
      counterparty: transaction.counterparty,
      // Carried through, never defaulted. The server replaces what the form
      // sends, so a blank here would move every edited entry onto the main
      // current account - including the ones raised from a bank line, which
      // knew perfectly well which account they came from.
      bankAccountId: transaction.bank_account_id ?? '',
      // Carried through for the same reason as the account above: the server
      // takes what the form sends, so a default here would untick it on every
      // edit.
      evidenceNotRequired: transaction.evidence_not_required,
      reference: transaction.reference ?? '',
      correctsTransactionId: transaction.corrects_transaction_id,
      correctionReason: transaction.correction_reason ?? '',
      lines: transaction.lines.map((line) => ({
        categoryId: line.category_id,
        // "What it was for" used to be asked once for the whole entry and is now
        // asked per line. An entry recorded under the old shape has the text at
        // the top and nothing on its lines, so it is handed down here rather
        // than being lost the moment somebody opens it to change a date.
        description: line.description || transaction.description,
        vatTreatment: line.vat_treatment,
        vatRateCode: line.vat_rate_code,
        vatRatePercent: line.vat_rate_percent,
        netAmount: line.net_amount,
        vatAmount: line.vat_amount,
        grossAmount: line.gross_amount,
        // The stored flag, not false: the server replaces lines wholesale on
        // save, so a hardcoded false here silently stripped the capital flag
        // from every edited entry - and with it the SA103/CT600 grouping.
        isCapital: line.is_capital,
        // Same trap, same reason: lines are replaced wholesale on save, so a
        // hardcoded false here would untick the asset on every edit and quietly
        // delete the draft it raised.
        registerAsset: line.register_asset,
      })),
    }
    return (
      <div>
        <BookkeepingNav active="transactions" />
        <SandboxBanner environment={environment} />
        <button className="btn btn-sm" style={{ marginBottom: '1rem' }} onClick={() => setEditing(false)}>
          Stop editing
        </button>
        <TransactionForm initial={value} />
      </div>
    )
  }

  return (
    <div>
      <BookkeepingNav active="transactions" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {locked && (
        <LockedNotice
          periodId={transaction.locked_period_id!}
          onCorrect={() => {
            window.location.href = `/${adminPath}/m/uk-bookkeeping/transactions/new?correcting=${transaction.id}`
          }}
        />
      )}

      {finalised && (
        <div
          className="card"
          style={{ padding: '0.875rem 1rem', marginBottom: '1rem', background: 'var(--color-surface)' }}
        >
          This entry is on a return that has been finalised but not yet filed. Reopen that return if
          you need to change it.
        </div>
      )}

      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          {transaction.counterparty}
        </h1>
        {canRecord && !locked && !finalised && (
          <>
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-sm" onClick={remove}>Delete</button>
          </>
        )}
        {canRecord && transaction.status === 'draft' && (
          <button className="btn btn-sm btn-primary" onClick={post}>
            Looks right - record it
          </button>
        )}
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem', maxWidth: 900 }}>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1.5rem', margin: 0 }}>
          <dt style={{ color: 'var(--color-text-muted, var(--color-text))' }}>Date</dt>
          <dd style={{ margin: 0 }}>{formatDate(transaction.tax_point_date)}</dd>
          <dt style={{ color: 'var(--color-text-muted, var(--color-text))' }}>Paid</dt>
          <dd style={{ margin: 0 }}>{formatDate(transaction.settled_date)}</dd>
          <dt style={{ color: 'var(--color-text-muted, var(--color-text))' }}>In or out</dt>
          <dd style={{ margin: 0 }}>{transaction.direction === 'income' ? 'Money in' : 'Money out'}</dd>
          <dt style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
            {transaction.direction === 'income' ? 'Paid into' : 'Paid from'}
          </dt>
          <dd style={{ margin: 0 }}>
            {transaction.bank_account_id
              ? (bankAccountNames[transaction.bank_account_id] ?? 'An account since removed')
              : 'Main current account'}
          </dd>
          <dt style={{ color: 'var(--color-text-muted, var(--color-text))' }}>What for</dt>
          <dd style={{ margin: 0 }}>{transaction.description || '—'}</dd>
          <dt style={{ color: 'var(--color-text-muted, var(--color-text))' }}>Their reference</dt>
          <dd style={{ margin: 0 }}>{transaction.reference || '—'}</dd>
          {transaction.correction_reason && (
            <>
              <dt style={{ color: 'var(--color-text-muted, var(--color-text))' }}>Correcting</dt>
              <dd style={{ margin: 0 }}>
                {transaction.correction_reason}{' '}
                {transaction.corrects_transaction_id && (
                  <a href={`/${adminPath}/m/uk-bookkeeping/transactions/${transaction.corrects_transaction_id}`}>
                    (see the original)
                  </a>
                )}
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: '1rem', overflowX: 'auto', maxWidth: 900 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
              <th style={{ padding: '0.625rem 0.75rem' }}>What it was for</th>
              <th style={{ padding: '0.625rem 0.75rem' }}>Category</th>
              <th style={{ padding: '0.625rem 0.75rem' }}>VAT</th>
              <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Before VAT</th>
              <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>VAT</th>
              <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {transaction.lines.map((line) => (
              <tr key={line.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '0.5rem 0.75rem' }}>{line.description || '—'}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  {transaction.category_names[line.category_id] ?? '—'}
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{line.vat_rate_code.replace('_', ' ')}</td>
                <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{poundsFromString(line.net_amount)}</td>
                <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{poundsFromString(line.vat_amount)}</td>
                <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{poundsFromString(line.gross_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <EvidenceDropzone
        transactionId={transaction.id}
        attachments={transaction.attachments}
        notRequired={transaction.evidence_not_required}
        locked={locked || finalised}
        canRecord={canRecord}
        onChange={load}
      />

      {canRecord && !locked && !finalised && (
        <>
          <ErrorNotice message={pickerError} />
          <DocumentPicker
            chosen={[]}
            reloadKey={pickerKey}
            onRelease={() => undefined}
            onChoose={async (document: UnfiledDocument) => {
              setPickerError(null)
              try {
                const response = await fetch(
                  `/api/m/uk-bookkeeping/admin/documents/${document.id}/attach`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transactionId: transaction.id }),
                  },
                )
                if (!response.ok) {
                  const payload = await response.json().catch(() => ({}))
                  setPickerError(payload.error ?? 'That receipt could not be attached.')
                  return
                }
                setPickerKey((key) => key + 1)
                load()
              } catch {
                setPickerError('That did not reach the server. Check the connection and try again.')
              }
            }}
          />
        </>
      )}
    </div>
  )
}
