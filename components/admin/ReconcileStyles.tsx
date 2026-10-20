// Layout for the reconcile screen.
//
// One stylesheet so the screen can be a proper two-pane workbench - the bank's
// line on the left, what the books make of it on the right - rather than a
// table with a cell that does everything.
//
// A <style> element rather than inline styles because the layout has to respond
// to the space it is given. Media queries, deliberately, not container queries:
// a container query makes the card a containing block for fixed-position
// descendants, and the category picker's list is position: fixed so it can
// escape a scrolling card. Class names are all prefixed bkr- so nothing here can
// collide with a core utility class.
//
// Colours are the platform's semantic tokens throughout, never hex.

const css = `
.bkr{display:flex;flex-direction:column;gap:1rem;min-width:0}
.bkr *{box-sizing:border-box}
.bkr-card{border:1px solid var(--color-border);border-radius:14px;background:var(--color-surface);min-width:0}
.bkr-muted{color:var(--color-text-muted,var(--color-text))}
.bkr-tiny{color:var(--color-text-muted,var(--color-text));font-size:var(--text-xs,.75rem);line-height:1.45}
.bkr-num{font-variant-numeric:tabular-nums}
.bkr-input{min-height:2.25rem;padding:.375rem .625rem;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg);color:var(--color-text);font:inherit;font-size:var(--text-sm);max-width:100%}
.bkr-input:focus-visible,.bkr button:focus-visible,.bkr a:focus-visible{outline:2px solid var(--color-primary,var(--color-text));outline-offset:2px}
.bkr-linkbtn{appearance:none;border:0;background:transparent;color:var(--color-text-muted,var(--color-text));font:inherit;font-size:var(--text-xs,.75rem);cursor:pointer;padding:.125rem 0;text-decoration:underline;text-underline-offset:2px}
.bkr-linkbtn:hover:not(:disabled){color:var(--color-text)}
.bkr-linkbtn:disabled{opacity:.5;cursor:not-allowed}

/* Notices */
.bkr-note{display:flex;gap:.75rem;align-items:flex-start;padding:.75rem 1rem;border:1px solid var(--color-border);border-radius:12px;background:var(--color-surface);font-size:var(--text-sm);line-height:1.5}
.bkr-note-ico{flex:0 0 1.5rem;width:1.5rem;height:1.5rem;display:flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--color-border);color:var(--color-text-muted,var(--color-text))}
.bkr-note[data-tone="good"]{border-color:var(--color-success,var(--color-border))}
.bkr-note[data-tone="good"] .bkr-note-ico{color:var(--color-success,var(--color-text));border-color:var(--color-success,var(--color-border))}
.bkr-note[data-tone="warn"]{border-color:var(--color-warning,var(--color-border))}
.bkr-note[data-tone="warn"] .bkr-note-ico{color:var(--color-warning,var(--color-text));border-color:var(--color-warning,var(--color-border))}
.bkr-note-body{flex:1;min-width:0}
.bkr-note-body p{margin:.375rem 0 0}
.bkr-note-body ul{margin:.375rem 0 0;padding-left:1.25rem}

/* Accounts */
.bkr-accts{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))}
.bkr-acct{appearance:none;text-align:left;font:inherit;color:var(--color-text);display:flex;align-items:center;gap:.75rem;padding:.75rem .875rem;border:1px solid var(--color-border);border-radius:12px;background:var(--color-surface);cursor:pointer;min-width:0}
.bkr-acct:hover{border-color:var(--color-text-muted,var(--color-text))}
.bkr-acct[aria-pressed="true"]{border-color:var(--color-primary,var(--color-text));box-shadow:0 0 0 1px var(--color-primary,var(--color-text))}
.bkr-acct-ico{flex:0 0 2.25rem;width:2.25rem;height:2.25rem;display:flex;align-items:center;justify-content:center;border-radius:999px;background:var(--color-bg);border:1px solid var(--color-border);color:var(--color-text-muted,var(--color-text))}
.bkr-acct[aria-pressed="true"] .bkr-acct-ico{background:var(--color-primary,var(--color-text));border-color:var(--color-primary,var(--color-text));color:var(--color-on-primary,var(--color-bg))}
.bkr-acct-body{flex:1;min-width:0;display:flex;flex-direction:column}
.bkr-acct-name{font-weight:600;font-size:var(--text-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bkr-count{flex:0 0 auto;min-width:1.5rem;padding:.0625rem .5rem;border-radius:999px;text-align:center;font-size:var(--text-xs,.75rem);font-weight:600;font-variant-numeric:tabular-nums;border:1px solid var(--color-border);background:var(--color-bg)}
.bkr-count[data-hot="true"]{background:var(--color-primary,var(--color-text));border-color:var(--color-primary,var(--color-text));color:var(--color-on-primary,var(--color-bg))}

/* The score */
.bkr-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.bkr-stat{padding:1rem 1.25rem;border-left:1px solid var(--color-border);min-width:0;display:flex;flex-direction:column;gap:.125rem}
.bkr-stat:first-child{border-left:0}
.bkr-stat-label{font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-muted,var(--color-text))}
.bkr-stat-value{font-size:1.5rem;font-weight:700;letter-spacing:-.01em;line-height:1.2;font-variant-numeric:tabular-nums}
.bkr-stat-value[data-tone="good"]{color:var(--color-success,var(--color-text))}
.bkr-progress{height:.5rem;border-radius:999px;background:var(--color-bg);border:1px solid var(--color-border);overflow:hidden;margin-top:.5rem}
.bkr-progress > span{display:block;height:100%;background:var(--color-primary,var(--color-text));border-radius:999px;transition:width .3s ease}
.bkr-progress[data-clear="true"] > span{background:var(--color-success,var(--color-primary))}
.bkr-stats-foot{padding:.75rem 1.25rem;border-top:1px solid var(--color-border);font-size:var(--text-sm);color:var(--color-text-muted,var(--color-text));line-height:1.5}

/* Toolbar */
.bkr-toolbar{display:flex;gap:.75rem 1rem;flex-wrap:wrap;align-items:center;padding:.75rem 1rem}
.bkr-seg{display:inline-flex;padding:3px;gap:2px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-bg);max-width:100%;flex-wrap:wrap}
.bkr-seg button{appearance:none;border:0;background:transparent;color:var(--color-text-muted,var(--color-text));font:inherit;font-size:var(--text-sm);font-weight:500;padding:.3125rem .75rem;border-radius:7px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:.4rem}
.bkr-seg button:hover{color:var(--color-text)}
.bkr-seg button[aria-pressed="true"]{background:var(--color-primary,var(--color-text));color:var(--color-on-primary,var(--color-bg));font-weight:600}
.bkr-seg small{font-size:var(--text-xs,.75rem);font-variant-numeric:tabular-nums;opacity:.8}
.bkr-grow{flex:1 1 14rem;min-width:0;position:relative}
.bkr-grow .bkr-input{width:100%;padding-left:2rem}
.bkr-grow svg{position:absolute;left:.625rem;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--color-text-muted,var(--color-text))}
.bkr-dates{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.bkr-dates label{display:flex;gap:.375rem;align-items:center;font-size:var(--text-xs,.75rem);font-weight:600;color:var(--color-text-muted,var(--color-text))}

/* The list */
.bkr-list-head{display:flex;gap:.75rem 1.25rem;flex-wrap:wrap;align-items:center;padding:.625rem 1.25rem;border-bottom:1px solid var(--color-border);background:var(--color-bg);border-radius:14px 14px 0 0;font-size:var(--text-sm)}
.bkr-list-head label{display:inline-flex;gap:.5rem;align-items:center;cursor:pointer}
.bkr-defaults{margin-left:auto;display:flex;gap:.5rem 1rem;flex-wrap:wrap;align-items:center;font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}
.bkr-defaults label{display:inline-flex;gap:.375rem;align-items:center}
.bkr-defaults select{min-height:2rem;padding:.25rem .5rem;border:1px solid var(--color-border);border-radius:8px;background:var(--color-surface);color:var(--color-text);font:inherit;font-size:var(--text-xs,.75rem)}
.bkr-line{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);border-top:1px solid var(--color-border)}
.bkr-line:first-of-type{border-top:0}
.bkr-line:last-of-type{border-radius:0 0 14px 14px;overflow:hidden}
.bkr-bank{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem .75rem;align-items:start;padding:1rem 1.25rem}
.bkr-bank[data-check="true"]{grid-template-columns:auto minmax(0,1fr) auto}
.bkr-line[data-selected="true"] .bkr-bank{background:color-mix(in srgb,var(--color-primary,var(--color-text)) 7%,transparent)}
.bkr-tick{margin-top:.25rem;width:1.0625rem;height:1.0625rem;cursor:pointer;accent-color:var(--color-primary,var(--color-text))}
.bkr-bank-main{min-width:0}
.bkr-date{font-size:var(--text-xs,.75rem);font-weight:600;color:var(--color-text-muted,var(--color-text));margin:0 0 .125rem}
.bkr-who{font-weight:600;overflow-wrap:anywhere;line-height:1.35}
.bkr-det{margin-top:.125rem;overflow-wrap:anywhere}
.bkr-chips{display:flex;gap:.375rem;flex-wrap:wrap;margin-top:.5rem}
.bkr-amount{text-align:right;white-space:nowrap}
.bkr-amt{font-size:1.1875rem;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums;line-height:1.25}
.bkr-amt[data-dir="in"]{color:var(--color-success,var(--color-text))}
.bkr-books{padding:1rem 1.25rem;background:var(--color-bg);border-left:1px solid var(--color-border);display:flex;flex-direction:column;gap:.625rem;min-width:0}
.bkr-kicker{margin:0;font-size:.6875rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--color-text-muted,var(--color-text))}
.bkr-pill{display:inline-flex;align-items:center;gap:.25rem;padding:.0625rem .5rem;border-radius:999px;border:1px solid var(--color-border);background:var(--color-surface);font-size:var(--text-xs,.75rem);line-height:1.5;white-space:nowrap}
.bkr-pill-good{color:var(--color-success,var(--color-text));border-color:var(--color-success,var(--color-border))}
.bkr-pill-warn{color:var(--color-warning,var(--color-text));border-color:var(--color-warning,var(--color-border))}
.bkr-pill-bad{color:var(--color-danger,var(--color-text));border-color:var(--color-danger,var(--color-border))}

/* A candidate: an entry, a transfer or a receipt the line might be */
.bkr-match{display:flex;gap:.75rem;align-items:center;padding:.625rem .75rem;border:1px solid var(--color-border);border-left:3px solid var(--color-primary,var(--color-text));border-radius:10px;background:var(--color-surface);min-width:0}
.bkr-match-ico{flex:0 0 2rem;width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;border-radius:999px;background:var(--color-bg);border:1px solid var(--color-border);color:var(--color-text-muted,var(--color-text))}
.bkr-match-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:.125rem}
.bkr-match-title{font-size:var(--text-sm);font-weight:600;overflow-wrap:anywhere}
.bkr-match-title a{color:var(--color-text);text-decoration:underline;text-decoration-color:var(--color-border);text-underline-offset:3px}
.bkr-match-title a:hover{text-decoration-color:var(--color-text)}
.bkr-match .btn{flex:0 0 auto}
.bkr-match-plain{border-left-width:1px}

/* Recording it as something new */
.bkr-record{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.bkr-more{display:flex;gap:.25rem 1.125rem;flex-wrap:wrap;align-items:center}
.bkr-done{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;font-size:var(--text-sm)}
.bkr-matched{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.375rem}
.bkr-matched li{display:flex;gap:.625rem;align-items:center;flex-wrap:wrap;padding:.5rem .75rem;border:1px solid var(--color-border);border-radius:10px;background:var(--color-surface);font-size:var(--text-sm)}
.bkr-matched .bkr-grow-text{flex:1;min-width:0;overflow-wrap:anywhere}

/* Sub-panels: pick a receipt, settle several invoices */
.bkr-sub{border:1px solid var(--color-border);border-radius:12px;background:var(--color-surface);padding:.75rem;display:flex;flex-direction:column;gap:.625rem;min-width:0}
.bkr-sub-title{margin:0;font-size:var(--text-sm);font-weight:600}
.bkr-sub .bkr-input{width:100%}
.bkr-scroll{max-height:15rem;overflow-y:auto;border:1px solid var(--color-border);border-radius:10px;background:var(--color-bg)}
.bkr-pick{display:flex;gap:.25rem .75rem;align-items:center;flex-wrap:wrap;padding:.5rem .75rem;border-top:1px solid var(--color-border);font-size:var(--text-sm)}
.bkr-pick:first-child{border-top:0}
.bkr-pick-main{flex:1 1 12rem;min-width:0;display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
.bkr-pick label{display:flex;gap:.5rem;align-items:baseline;flex:1 1 14rem;min-width:0;cursor:pointer}
.bkr-part{width:6.5rem;text-align:right}
.bkr-sum{padding:.625rem .75rem;border-radius:10px;background:var(--color-bg);border:1px solid var(--color-border);font-size:var(--text-sm);line-height:1.5}
.bkr-sum[data-settled="true"]{border-color:var(--color-success,var(--color-border))}

/* The bar that follows you down a long statement */
.bkr-bulk{position:sticky;bottom:1rem;z-index:20;display:flex;flex-direction:column;gap:.625rem;padding:.75rem 1rem;border:1px solid var(--color-primary,var(--color-border));border-radius:14px;background:var(--color-surface);box-shadow:0 10px 32px color-mix(in srgb,var(--color-text) 22%,transparent)}
.bkr-bulk-row{display:flex;gap:.5rem .75rem;flex-wrap:wrap;align-items:center}
.bkr-bulk-count{font-size:var(--text-sm);font-weight:600;padding-right:.25rem}
.bkr-bulk-sep{width:1px;align-self:stretch;background:var(--color-border);margin:0 .25rem}

.bkr-pager{display:flex;gap:.75rem;align-items:center;justify-content:center;font-size:var(--text-sm)}

.bkr-skel{height:5.5rem;border-top:1px solid var(--color-border);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--color-text) 6%,transparent),transparent);background-size:200% 100%;animation:bkr-shimmer 1.4s linear infinite}
.bkr-skel:first-child{border-top:0}
@keyframes bkr-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.bkr-skel{animation:none}.bkr-progress > span{transition:none}}

.bkr-empty{padding:3rem 1.5rem;text-align:center;border:1px dashed var(--color-border);border-radius:14px;color:var(--color-text-muted,var(--color-text))}
.bkr-empty-ico{width:3rem;height:3rem;margin:0 auto .75rem;display:flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--color-border);background:var(--color-surface)}
.bkr-empty[data-tone="good"] .bkr-empty-ico{color:var(--color-success,var(--color-text));border-color:var(--color-success,var(--color-border))}
.bkr-empty p{margin:0 auto;max-width:34rem;text-align:center}
.bkr-empty .bkr-empty-title{margin:0 auto .375rem;font-weight:600;font-size:1.0625rem;color:var(--color-text)}

@media (max-width:1180px){
  .bkr-line{grid-template-columns:minmax(0,1fr)}
  .bkr-books{border-left:0;border-top:1px solid var(--color-border)}
  .bkr-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .bkr-stat:nth-child(3){border-left:0}
  .bkr-stat:nth-child(n+3){border-top:1px solid var(--color-border)}
}
@media (max-width:640px){
  .bkr-stats{grid-template-columns:minmax(0,1fr)}
  .bkr-stat{border-left:0;border-top:1px solid var(--color-border)}
  .bkr-stat:first-child{border-top:0}
  .bkr-defaults{margin-left:0}
  .bkr-bank,.bkr-books{padding:.875rem 1rem}
  .bkr-match{flex-wrap:wrap}
  .bkr-bulk-sep{display:none}
}
`

export default function ReconcileStyles() {
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}
