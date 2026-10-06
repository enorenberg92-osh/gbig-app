export function ledgerBalances(entries) {
  const balances = new Map()
  for (const entry of entries) {
    const key = entry.player_id ? `p:${entry.player_id}` : `t:${entry.team_id}`
    const row = balances.get(key) || { key, player_id: entry.player_id, team_id: entry.team_id, amt: 0 }
    row.amt += Number(entry.amount)
    balances.set(key, row)
  }
  return [...balances.values()].sort((a,b) => b.amt - a.amt)
}
