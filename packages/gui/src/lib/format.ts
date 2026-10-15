/** Shared number/time formatting for the GUI. */

export const fmtTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? (n / 1000).toFixed(1) + 'k' : (n / 1e6).toFixed(1) + 'M'

export const fmtCost = (n: number): string => (n ? '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(3)) : '$0')

export const fmtTime = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
