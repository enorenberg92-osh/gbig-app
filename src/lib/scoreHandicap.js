export function scoreHandicap(player, existing, sub) {
  // A correction retains the round's original handicap after later recalculations.
  if (existing?.entry_type === 'played' && existing.handicap_used != null) return existing.handicap_used
  return sub?.sub_handicap ?? player?.handicap ?? 0
}
