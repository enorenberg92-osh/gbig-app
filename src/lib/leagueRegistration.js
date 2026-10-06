import { fetchAllRows } from './fetchAllRows'
export async function loadLeagueRegistrations(client, leagueId, locationId) {
  if (!leagueId) return []
  const { data, error } = await fetchAllRows(() => client.from('league_onboarding')
    .select('id,player_id,account_status,email_status,account_error,email_error,lease_until,player:players(name,email)')
    .eq('league_id',leagueId).eq('location_id',locationId).order('id'))
  if (error) throw error
  return data
}
export async function finishLeagueRegistrations(client, leagueId, playerIds, onProgress = () => {}) {
  // Attempt each player once per run; failed emails stay available for retry.
  let remaining = [...new Set(playerIds)], completed = 0
  const results = []
  while (remaining.length) {
    const batch = remaining.slice(0,10)
    const { data:{session} } = await client.auth.getSession()
    if (!session?.access_token) throw new Error('Sign in again to finish registration.')
    const { data, error } = await client.functions.invoke('league-onboarding', {body:{league_id:leagueId,player_ids:batch},headers:{Authorization:`Bearer ${session.access_token}`}})
    if (error || data?.error) {
      let message=data?.error
      if(!message&&error?.context?.json)try{message=(await error.context.json()).error}catch{}
      throw new Error(message || error?.message || 'Registration could not finish. Retry pending registrations.')
    }
    results.push(...(data?.results || []))
    remaining = remaining.slice(batch.length); completed += batch.length
    onProgress(completed,playerIds.length)
  }
  return results
}
export function registrationSummary(jobs) {
  return { total:jobs.length, ready:jobs.filter(j=>j.account_status==='ready').length,
    sent:jobs.filter(j=>j.email_status==='sent').length, waiting:jobs.filter(j=>j.email_status==='not_configured').length,
    needsEmail:jobs.filter(j=>j.account_status==='needs_email').length,
    errors:jobs.filter(j=>j.account_status==='error'||['error','review'].includes(j.email_status)).length }
}
