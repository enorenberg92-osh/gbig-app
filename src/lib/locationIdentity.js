export const VENUES = {
  gbig: { slug:'gbig', name:'Green Bay Indoor Golf', primary_color:'#1b4332' },
  appleton: { slug:'appleton', name:'Appleton Indoor Golf', primary_color:'#1b4332' },
}
export function hostSlug(host) {
  const hostname=String(host || '').toLowerCase().split(':')[0]
  if (hostname==='localhost' || hostname==='127.0.0.1' || hostname==='') return null
  const deployment=hostname.match(/^(gbig|appleton)(?:-app)?(?:-[a-z0-9-]+)?\.vercel\.app$/)
  if(deployment) return deployment[1]
  return hostname.split('.')[0].replace(/-app$/, '')
}
export function validCachedLocation(value, slug) {
  return Boolean(value?.id && typeof value.id==='string' && (!slug || value.slug===slug))
}
export async function resolveLocation(client, {slug, fallbackId, cached}) {
  const bySlug=Boolean(slug && slug!=='www')
  let lastError
  for(let i=0;i<3;i++) {
    let query=client.from('location_public').select('*')
    if(bySlug) query=query.eq('slug',slug)
    else if(fallbackId) query=query.eq('id',fallbackId)
    else throw new Error('This app has no configured venue.')
    const result=await query.maybeSingle()
    if(!result.error) {
      if(!result.data?.id) throw new Error('This app address is not configured for a venue.')
      if(bySlug && result.data.slug!==slug) throw new Error('Venue lookup did not match this app address.')
      return result.data
    }
    lastError=result.error
  }
  if(validCachedLocation(cached,bySlug?slug:null)) return cached
  throw new Error(lastError?.message || 'Your venue could not be loaded. Check your connection and try again.')
}
