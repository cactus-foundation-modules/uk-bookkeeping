import type { EmailTemplateDef } from '@/lib/email/registry'

// The one email this module sends, and the reason it exists.
//
// It is the receipt for a filed VAT return, and it carries the records
// fingerprint - the head of the audit hash chain at the moment of filing. That
// mail sits in a mailbox this software cannot reach or edit, which is what turns
// the chain from a comforting illusion into a guarantee worth something: any
// later rewrite of history changes the head, and the head no longer matches what
// is in the owner's inbox.
//
// Keys are namespaced with the module's own name, which is what stops two
// modules claiming the same email. The owner can reword any of it in
// Settings → Emails; the required tags below are the ones it would be useless
// without.

export const ukBookkeepingEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'uk-bookkeeping.vat-return-filed',
    label: 'VAT return filed',
    subject: 'Your VAT return for {{periodStart}} to {{periodEnd}} has been filed',
    bodyHtml: `
<p>Your VAT return has gone to HMRC. Here is what was on it, for your records.</p>
<p><strong>Period:</strong> {{periodStart}} to {{periodEnd}}</p>
<table role="presentation" style="border-collapse:collapse">
  <tr><td style="padding:2px 12px 2px 0">Box 1 - VAT due on sales</td><td>{{box1}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 2 - VAT due on acquisitions</td><td>{{box2}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 3 - Total VAT due</td><td>{{box3}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 4 - VAT reclaimed</td><td>{{box4}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 5 - Net VAT</td><td>{{box5}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 6 - Sales excluding VAT</td><td>{{box6}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 7 - Purchases excluding VAT</td><td>{{box7}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 8 - Goods to the EU from NI</td><td>{{box8}}</td></tr>
  <tr><td style="padding:2px 12px 2px 0">Box 9 - Goods from the EU into NI</td><td>{{box9}}</td></tr>
</table>
<p><strong>HMRC reference:</strong> {{formBundleNumber}}</p>
<p><strong>Records fingerprint:</strong> {{recordsFingerprint}}</p>
<p>That fingerprint is worth keeping. It is a short code worked out from every entry
behind this return, and it only stays the same for as long as those entries do. Keep
this email and you keep a copy of it that nobody can quietly change later.</p>
`.trim(),
    mergeTags: [
      'periodStart',
      'periodEnd',
      'box1',
      'box2',
      'box3',
      'box4',
      'box5',
      'box6',
      'box7',
      'box8',
      'box9',
      'formBundleNumber',
      'recordsFingerprint',
    ],
    requiredTags: ['periodStart', 'periodEnd', 'box5', 'recordsFingerprint'],
    transactional: true,
  },
]
