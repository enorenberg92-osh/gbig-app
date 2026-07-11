export async function loadWorkingLeague(supabase, locationId) {
  const { data, error } = await supabase
    .from('league_config')
    .select('id, name, num_weeks, start_date, is_active, is_working')
    .eq('location_id', locationId)
    .eq('is_working', true)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('Choose a working league in Admin > Leagues first.')
  return data
}

