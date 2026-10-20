/** Shared number/time formatting for the GUI. */

export const fmtTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? (n / 1000).toFixed(1) + 'k' : (n / 1e6).toFixed(1) + 'M'

export const fmtCost = (n: number): string => {
  if (!n) return '$0'
  if (n < 0.0001) return '$' + n.toFixed(6)
  if (n < 0.01) return '$' + n.toFixed(4)
  return '$' + n.toFixed(3)
}

export const fmtTime = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
