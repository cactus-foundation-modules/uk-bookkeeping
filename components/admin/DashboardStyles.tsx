// Layout for the overview.
//
// A <style> element rather than inline styles because the grid has to rearrange
// itself as the page narrows, and inline styles cannot carry a media query.
// Class names are all prefixed bko- so nothing here can collide with a core
// utility class. Colours are the platform's semantic tokens throughout, never
// hex, and every surface is meant to read in both light and dark mode.

const css = `
.bko{display:flex;flex-direction:column;gap:1.25rem;min-width:0}
.bko *{box-sizing:border-box}
.bko a:focus-visible,.bko button:focus-visible{outline:2px solid var(--color-primary,var(--color-text));outline-offset:2px}
.bko-num{font-variant-numeric:tabular-nums}
.bko-muted{color:var(--color-text-muted,var(--color-text))}

/* Header */
.bko-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.bko-eyebrow{font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-muted,var(--color-text));margin:0 0 .25rem}
.bko-h1{margin:0;font-size:1.625rem;font-weight:700;letter-spacing:-.015em;line-height:1.2}
.bko-sub{margin:.25rem 0 0;color:var(--color-text-muted,var(--color-text));font-size:var(--text-sm)}
.bko-actions{display:flex;gap:.5rem;flex-wrap:wrap}

/* Cards */
.bko-card{border:1px solid var(--color-border);border-radius:16px;background:var(--color-surface);min-width:0}
.bko-card-pad{padding:1.25rem 1.5rem}
.bko-card-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin:0 0 1rem}
.bko-title{margin:0;font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-muted,var(--color-text))}
.bko-link{font-size:var(--text-sm);color:var(--color-text);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--color-border)}
.bko-link:hover{text-decoration-color:var(--color-text)}

/* Pills */
.bko-pill{display:inline-flex;align-items:center;gap:.375rem;padding:.125rem .625rem;border-radius:999px;border:1px solid var(--color-border);font-size:var(--text-xs,.75rem);font-weight:600;line-height:1.5;white-space:nowrap;color:var(--color-text-muted,var(--color-text))}
.bko-pill::before{content:"";width:.4375rem;height:.4375rem;border-radius:999px;background:currentColor}
.bko-pill[data-tone="good"]{color:var(--color-success,var(--color-text));border-color:var(--color-success,var(--color-border))}
.bko-pill[data-tone="warn"]{color:var(--color-warning,var(--color-text));border-color:var(--color-warning,var(--color-border))}
.bko-pill[data-tone="bad"]{color:var(--color-danger,var(--color-text));border-color:var(--color-danger,var(--color-border))}

/* Top band: VAT hero + attention queue */
.bko-top{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:1.25rem;align-items:stretch}
.bko-hero{display:flex;flex-direction:column;gap:1rem;padding:1.5rem}
.bko-hero-main{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.bko-hero-figure{font-size:2.75rem;font-weight:700;letter-spacing:-.025em;line-height:1.05;font-variant-numeric:tabular-nums}
.bko-hero-figure[data-tone="bad"]{color:var(--color-danger,var(--color-text))}
.bko-hero-note{margin:.375rem 0 0;color:var(--color-text-muted,var(--color-text));font-size:var(--text-sm)}
.bko-hero-side{display:flex;flex-direction:column;align-items:flex-end;gap:.375rem;text-align:right}
.bko-due{font-size:1.125rem;font-weight:700;font-variant-numeric:tabular-nums}
.bko-due[data-tone="bad"]{color:var(--color-danger,var(--color-text))}
.bko-progress{height:.5rem;border-radius:999px;background:var(--color-bg);border:1px solid var(--color-border);overflow:hidden}
.bko-progress > span{display:block;height:100%;border-radius:999px;background:var(--color-primary,var(--color-text));transition:width .4s ease}
.bko-progress-labels{display:flex;justify-content:space-between;gap:.5rem;margin-top:.375rem;font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}
.bko-split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--color-border);margin:0 -1.5rem -1.5rem}
.bko-split > div{padding:1rem 1.5rem;display:flex;flex-direction:column;gap:.125rem}
.bko-split > div + div{border-left:1px solid var(--color-border)}
.bko-mini-label{font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}
.bko-mini-value{font-size:1.125rem;font-weight:700;font-variant-numeric:tabular-nums}

/* Attention queue */
.bko-queue{display:flex;flex-direction:column;padding:0;margin:0;list-style:none}
.bko-queue li + li{border-top:1px solid var(--color-border)}
.bko-qrow{display:flex;align-items:center;gap:.875rem;padding:.875rem 1.5rem;color:var(--color-text);text-decoration:none}
.bko-qrow:hover{background:var(--color-bg)}
.bko-qico{flex:0 0 2.25rem;width:2.25rem;height:2.25rem;display:flex;align-items:center;justify-content:center;border-radius:10px;background:var(--color-bg);border:1px solid var(--color-border);color:var(--color-text-muted,var(--color-text))}
.bko-qbody{flex:1;min-width:0;display:flex;flex-direction:column}
.bko-qlabel{font-size:var(--text-sm);font-weight:600}
.bko-qhint{font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}
.bko-qcount{flex:0 0 auto;min-width:1.75rem;padding:.125rem .5rem;border-radius:999px;text-align:center;font-size:var(--text-xs,.75rem);font-weight:700;font-variant-numeric:tabular-nums;background:var(--color-primary,var(--color-text));color:var(--color-on-primary,var(--color-bg))}
.bko-chev{flex:0 0 auto;color:var(--color-text-muted,var(--color-text))}
.bko-clear{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.625rem;padding:2rem 1.5rem;text-align:center;flex:1}
.bko-clear-ico{width:3rem;height:3rem;display:flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--color-success,var(--color-border));color:var(--color-success,var(--color-text))}

/* KPI strip */
.bko-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.bko-kpi{padding:1.125rem 1.5rem;display:flex;flex-direction:column;gap:.25rem;min-width:0;color:var(--color-text);text-decoration:none}
a.bko-kpi:hover{background:var(--color-bg)}
.bko-kpi + .bko-kpi{border-left:1px solid var(--color-border)}
.bko-kpi:first-child{border-radius:16px 0 0 16px}
.bko-kpi:last-child{border-radius:0 16px 16px 0}
.bko-kpi-value{font-size:1.5rem;font-weight:700;letter-spacing:-.015em;line-height:1.2;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.bko-kpi-value[data-tone="good"]{color:var(--color-success,var(--color-text))}
.bko-kpi-value[data-tone="bad"]{color:var(--color-danger,var(--color-text))}
.bko-kpi-note{font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}

/* Lower band: chart + recent */
.bko-low{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.25rem;align-items:start}
.bko-legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}
.bko-key{display:inline-flex;align-items:center;gap:.375rem}
.bko-swatch{width:.75rem;height:.75rem;border-radius:3px;background:var(--color-primary,var(--color-text))}
.bko-swatch[data-kind="out"]{background:var(--color-border);box-shadow:inset 0 0 0 1px var(--color-text-muted,var(--color-text))}
.bko-chart{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:.5rem;align-items:end}
.bko-col{display:flex;flex-direction:column;align-items:center;gap:.5rem;min-width:0}
.bko-bars{display:flex;align-items:flex-end;justify-content:center;gap:.25rem;height:10rem;width:100%;border-bottom:1px solid var(--color-border)}
.bko-bar{flex:1 1 0;max-width:1.5rem;min-height:2px;border-radius:5px 5px 0 0;background:var(--color-primary,var(--color-text));transition:height .4s ease}
.bko-bar[data-kind="out"]{background:var(--color-border);box-shadow:inset 0 0 0 1px var(--color-text-muted,var(--color-text))}
.bko-month{font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text))}
.bko-month[data-now="true"]{color:var(--color-text);font-weight:700}
.bko-profit{font-size:var(--text-xs,.75rem);font-weight:600;font-variant-numeric:tabular-nums}
.bko-profit[data-tone="bad"]{color:var(--color-danger,var(--color-text))}

/* Recent */
.bko-feed{list-style:none;margin:0;padding:0}
.bko-feed li + li{border-top:1px solid var(--color-border)}
.bko-item{display:flex;align-items:center;gap:.875rem;padding:.75rem 1.5rem;color:var(--color-text);text-decoration:none}
.bko-item:hover{background:var(--color-bg)}
.bko-av{flex:0 0 2.25rem;width:2.25rem;height:2.25rem;display:flex;align-items:center;justify-content:center;border-radius:999px;background:var(--color-bg);border:1px solid var(--color-border);font-size:.8125rem;font-weight:700;color:var(--color-text-muted,var(--color-text))}
.bko-ibody{flex:1;min-width:0;display:flex;flex-direction:column}
.bko-iname{font-size:var(--text-sm);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bko-imeta{font-size:var(--text-xs,.75rem);color:var(--color-text-muted,var(--color-text));display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.bko-amt{flex:0 0 auto;font-size:var(--text-sm);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.bko-amt[data-tone="in"]{color:var(--color-success,var(--color-text))}
.bko-feed-foot{padding:.75rem 1.5rem;border-top:1px solid var(--color-border)}

/* Shortcuts */
.bko-shortcuts{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.75rem}
.bko-short{display:flex;align-items:center;gap:.75rem;padding:.875rem 1rem;border:1px solid var(--color-border);border-radius:12px;background:var(--color-surface);color:var(--color-text);text-decoration:none;font-size:var(--text-sm);font-weight:600}
.bko-short:hover{border-color:var(--color-text-muted,var(--color-text))}

/* Skeleton */
.bko-skel{background:var(--color-bg);border-radius:8px;animation:bko-pulse 1.4s ease-in-out infinite}
@keyframes bko-pulse{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.bko-skel{animation:none}.bko-progress > span,.bko-bar{transition:none}}

/* Notice cards */
.bko-notice{display:flex;gap:.75rem;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:.875rem 1.25rem;border:1px solid var(--color-warning,var(--color-border));border-radius:12px;background:var(--color-surface);font-size:var(--text-sm)}

@media (max-width:1100px){
  .bko-top,.bko-low{grid-template-columns:minmax(0,1fr)}
  .bko-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .bko-kpi:nth-child(3){border-left:0}
  .bko-kpi:nth-child(n+3){border-top:1px solid var(--color-border)}
  .bko-kpi:first-child{border-radius:16px 0 0 0}
  .bko-kpi:nth-child(2){border-radius:0 16px 0 0}
  .bko-kpi:nth-child(3){border-radius:0 0 0 16px}
  .bko-kpi:last-child{border-radius:0 0 16px 0}
}
@media (max-width:560px){
  .bko-h1{font-size:1.375rem}
  .bko-hero{padding:1.125rem}
  .bko-hero-figure{font-size:2.125rem}
  .bko-hero-side{align-items:flex-start;text-align:left}
  .bko-split{margin:0 -1.125rem -1.125rem}
  .bko-split > div{padding:.875rem 1.125rem}
  .bko-kpis{grid-template-columns:minmax(0,1fr)}
  .bko-kpi{border-left:0 !important;border-radius:0 !important}
  .bko-kpi + .bko-kpi{border-top:1px solid var(--color-border)}
  .bko-qrow,.bko-item,.bko-feed-foot{padding-left:1rem;padding-right:1rem}
  .bko-card-pad{padding:1.125rem 1rem}
}
`

export default function DashboardStyles() {
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}
