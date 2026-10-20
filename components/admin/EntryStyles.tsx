// Layout for the entry form and the entry page.
//
// One stylesheet for both screens so a viewed entry and the same entry being
// edited are visibly the same page: a wide main column on the left, and a sticky
// side column on the right that holds the figures and the receipts.
//
// A <style> element rather than inline styles because the layout has to respond
// to the width it is given. The admin sidebar changes how much room the page has
// without changing the viewport, so the breakpoints are CONTAINER queries on the
// card, not media queries on the window. Class names are all prefixed bkx- so
// nothing here can collide with a core utility class.
//
// Colours are the platform's semantic tokens throughout, never hex.

const css = `
.bkx-layout{display:grid;grid-template-columns:minmax(0,1fr) 23rem;gap:1rem;align-items:start;width:100%}
.bkx-main,.bkx-side{display:flex;flex-direction:column;gap:1rem;min-width:0}
.bkx-side{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow-y:auto}
@media (max-width:1180px){
  .bkx-layout{grid-template-columns:minmax(0,1fr)}
  .bkx-side{position:static;max-height:none;overflow:visible}
}

.bkx-card{container-type:inline-size;border:1px solid var(--color-border);border-radius:12px;background:var(--color-surface);padding:1.125rem 1.25rem;min-width:0}
.bkx-card-flush{padding:0;overflow:hidden}
.bkx-card-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin:0 0 .875rem}
.bkx-card-flush .bkx-card-head{padding:1rem 1.25rem 0;margin-bottom:.75rem}
.bkx-title{margin:0;font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-muted,var(--color-text))}
.bkx-muted{color:var(--color-text-muted,var(--color-text));font-size:var(--text-sm)}
.bkx-tiny{color:var(--color-text-muted,var(--color-text));font-size:var(--text-xs,.75rem);line-height:1.45}

.bkx-field label,.bkx-label{display:block;margin:0 0 .25rem;font-size:var(--text-xs,.75rem);font-weight:600;color:var(--color-text-muted,var(--color-text))}
.bkx-input{width:100%;min-height:2.25rem;padding:.375rem .625rem;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg);color:var(--color-text);font:inherit;font-size:var(--text-sm);box-sizing:border-box}
.bkx-input:focus-visible{outline:2px solid var(--color-primary,var(--color-text));outline-offset:1px}
.bkx-money{text-align:right;font-variant-numeric:tabular-nums}

/* Money in / out / transfer, as a segmented control rather than a dropdown: it is
   the first thing decided and it changes what the rest of the form asks. */
.bkx-seg{display:inline-flex;padding:3px;gap:2px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-bg);max-width:100%;flex-wrap:wrap}
.bkx-seg button{appearance:none;border:0;background:transparent;color:var(--color-text-muted,var(--color-text));font:inherit;font-size:var(--text-sm);font-weight:500;padding:.3125rem .75rem;border-radius:7px;cursor:pointer;white-space:nowrap}
.bkx-seg button:hover{color:var(--color-text)}
.bkx-seg button[aria-pressed="true"]{background:var(--color-primary);color:var(--color-on-primary,var(--color-bg));font-weight:600}
.bkx-seg button:focus-visible{outline:2px solid var(--color-primary,var(--color-text));outline-offset:1px}

/* Details: three across when there is room, two, then one. The counterparty takes
   two cells, so six fields always fill whole rows and never leave a gap. */
.bkx-grid{display:grid;gap:.875rem 1rem;grid-template-columns:repeat(3,minmax(0,1fr))}
.bkx-grid .bkx-span2{grid-column:span 2}
.bkx-grid .bkx-spanall{grid-column:1/-1}
.bkx-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
@container (max-width:44rem){
  .bkx-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@container (max-width:26rem){
  .bkx-grid,.bkx-grid-2{grid-template-columns:minmax(0,1fr)}
  .bkx-grid .bkx-span2{grid-column:auto}
}

/* The facts on a viewed entry: label over value, filling the width. */
.bkx-facts{display:grid;gap:1rem 1.25rem;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));margin:0}
.bkx-facts dt{margin:0 0 .125rem;font-size:var(--text-xs,.75rem);font-weight:600;color:var(--color-text-muted,var(--color-text))}
.bkx-facts dd{margin:0;font-size:.9375rem;overflow-wrap:anywhere}

/* Line items. Column labels once, above the first line, so every line is a single
   row instead of a block of eight stacked fields. Under 46rem each cell carries
   its own label instead and the row folds into two columns. */
.bkx-lines-head,.bkx-line-row{display:grid;gap:.5rem .625rem;grid-template-columns:minmax(0,2.4fr) minmax(0,1.7fr) minmax(0,1.3fr) minmax(5.5rem,1fr) minmax(5rem,.9fr) minmax(5.5rem,1fr)}
.bkx-lines-head{padding:0 0 .375rem;font-size:var(--text-xs,.75rem);font-weight:600;color:var(--color-text-muted,var(--color-text))}
.bkx-lines-head .bkx-r{text-align:right}
.bkx-line{padding:.75rem 0;border-top:1px solid var(--color-border)}
.bkx-line:first-of-type{border-top:0}
.bkx-cell-label{display:none}
.bkx-derived{display:flex;align-items:center;justify-content:flex-end;gap:.375rem;min-height:2.25rem;padding:.375rem .625rem;border:1px dashed var(--color-border);border-radius:8px;color:var(--color-text-muted,var(--color-text));font-size:var(--text-sm);font-variant-numeric:tabular-nums;box-sizing:border-box;width:100%}
.bkx-derived button{appearance:none;border:0;background:transparent;color:var(--color-primary,var(--color-text));font:inherit;font-size:var(--text-xs,.75rem);cursor:pointer;padding:0;text-decoration:underline}
.bkx-line-foot{display:flex;align-items:center;gap:.5rem 1rem;flex-wrap:wrap;margin-top:.5rem;font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}
.bkx-line-foot select{appearance:auto;border:0;background:transparent;color:var(--color-text);font:inherit;font-size:var(--text-xs,.75rem);font-weight:600;padding:0 .25rem;max-width:100%;cursor:pointer}
.bkx-line-foot label{display:inline-flex;align-items:center;gap:.375rem;cursor:pointer}
.bkx-line-foot .bkx-spacer{margin-left:auto}
.bkx-linkbtn{appearance:none;border:0;background:transparent;color:var(--color-primary,var(--color-text));font:inherit;font-size:var(--text-xs,.75rem);cursor:pointer;padding:0;text-decoration:underline}
.bkx-warn{color:var(--color-warning,var(--color-text))}
@container (max-width:46rem){
  .bkx-lines-head{display:none}
  .bkx-line-row{grid-template-columns:repeat(2,minmax(0,1fr))}
  .bkx-line-row .bkx-c-desc{grid-column:1/-1}
  .bkx-cell-label{display:block;margin:0 0 .25rem;font-size:var(--text-xs,.75rem);font-weight:600;color:var(--color-text-muted,var(--color-text))}
}

/* Summary */
.bkx-sum{display:grid;gap:.5rem;margin:0}
.bkx-sum-row{display:flex;justify-content:space-between;gap:1rem;font-size:.9375rem;font-variant-numeric:tabular-nums}
.bkx-sum-row dt,.bkx-sum-row dd{margin:0}
.bkx-sum-row.bkx-sub{font-size:var(--text-sm);color:var(--color-text-muted,var(--color-text));padding-left:.75rem}
.bkx-sum-total{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-top:.25rem;padding-top:.75rem;border-top:1px solid var(--color-border)}
.bkx-sum-total .bkx-big{font-size:1.75rem;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums;line-height:1.1}
.bkx-actions{display:flex;flex-direction:column;gap:.5rem;margin-top:1rem}
.bkx-actions .btn{width:100%;justify-content:center;text-align:center}

/* Receipts */
.bkx-drop{border:2px dashed var(--color-border);border-radius:10px;padding:.875rem;text-align:center;color:var(--color-text-muted,var(--color-text));font-size:var(--text-sm);transition:border-color .12s,background .12s}
.bkx-drop[data-dragging="true"]{border-color:var(--color-primary,var(--color-text));background:var(--color-bg)}
.bkx-files{list-style:none;margin:0 0 .75rem;padding:0;display:grid;gap:.5rem}
.bkx-file{display:flex;align-items:center;gap:.625rem;padding:.375rem;border:1px solid var(--color-border);border-radius:10px;background:var(--color-bg);min-width:0}
.bkx-thumb{flex:0 0 2.75rem;width:2.75rem;height:2.75rem;border-radius:7px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--color-surface);border:1px solid var(--color-border);font-size:var(--text-xs,.75rem);font-weight:700;color:var(--color-text-muted,var(--color-text))}
.bkx-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.bkx-file-body{flex:1;min-width:0;display:flex;flex-direction:column}
.bkx-file-body a,.bkx-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-sm)}
.bkx-pill{display:inline-flex;align-items:center;gap:.25rem;padding:.0625rem .5rem;border-radius:999px;border:1px solid var(--color-border);font-size:var(--text-xs,.75rem);line-height:1.5;white-space:nowrap}
.bkx-pill-out{color:var(--color-danger,var(--color-text));border-color:var(--color-danger,var(--color-border))}
.bkx-pill-in{color:var(--color-success,var(--color-text));border-color:var(--color-success,var(--color-border))}
.bkx-pill-warn{color:var(--color-warning,var(--color-text));border-color:var(--color-warning,var(--color-border))}
.bkx-head{display:flex;align-items:flex-start;gap:.75rem 1rem;flex-wrap:wrap;margin:0 0 1rem}
.bkx-head-title{flex:1 1 18rem;min-width:0}
.bkx-head-title h1{margin:0}
.bkx-head-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-left:auto}
.bkx-chips{display:flex;gap:.375rem;flex-wrap:wrap;margin-top:.5rem}
.bkx-table-wrap{overflow-x:auto}
.bkx-table{width:100%;border-collapse:collapse;font-size:var(--text-sm)}
.bkx-table th{padding:.5rem 1.25rem;text-align:left;font-size:var(--text-xs,.75rem);font-weight:600;color:var(--color-text-muted,var(--color-text));border-bottom:1px solid var(--color-border);white-space:nowrap}
.bkx-table td{padding:.625rem 1.25rem;border-bottom:1px solid var(--color-border);vertical-align:top}
.bkx-table tr:last-child td{border-bottom:0}
.bkx-table .bkx-r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
`

export default function EntryStyles() {
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}
