import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'

// Read-only public deployment and venue checks. Never writes league data.
const envFile = process.argv[2]
if (!envFile) throw new Error('Provide the existing local environment file path.')
const env = Object.fromEntries(fs.readFileSync(envFile,'utf8').split(/\r?\n/).filter(line=>/^VITE_SUPABASE_(URL|ANON_KEY)=/.test(line)).map(line=>{
  const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1).trim().replace(/^["']|["']$/g,'')]
}))
const supabase = createClient(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
const results=[]
for (const [slug,name] of [['gbig','Green Bay Indoor Golf'],['appleton','Appleton Indoor Golf']]) {
  const origin=`https://${slug}-app.vercel.app`
  const page = await fetch(`${origin}/league`,{cache:'no-store'})
  assert.equal(page.status,200)
  const html=await page.text()
  assert.ok(html.includes('/location-brand.js'))
  const bundle=html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
  assert.ok(bundle)
  assert.equal((await fetch(origin+bundle)).status,200)
  const brand=await fetch(`${origin}/location-brand.js`,{cache:'no-store'})
  assert.equal(brand.status,200)
  assert.ok((await brand.text()).includes('Appleton Indoor Golf'))
  const response=await fetch(`${origin}/api/manifest`,{cache:'no-store'})
  assert.equal(response.status,200)
  const manifest=await response.json()
  assert.equal(manifest.name,name)
  assert.equal(manifest.id,'/')
  assert.ok(response.headers.get('cache-control')?.includes('no-cache'))
  for(const icon of manifest.icons) {
    assert.ok(icon.src.includes(`/branding/${slug}-`))
    const asset=await fetch(origin+icon.src)
    assert.equal(asset.status,200)
    const png=Buffer.from(await asset.arrayBuffer())
    assert.equal(png.subarray(1,4).toString(),'PNG')
    const dimension=Number(icon.sizes.split('x')[0])
    assert.equal(png.readUInt32BE(16),dimension)
    assert.equal(png.readUInt32BE(20),dimension)
  }
  const {data:venue,error}=await supabase.from('location_public').select('id,slug,name,booking_url').eq('slug',slug).single()
  if(error)throw error
  assert.equal(venue.name,name)
  assert.ok(venue.booking_url.includes(slug==='appleton'?'appletonindoorgolf.com':'greenbayindoorgolf.com'))
  results.push({venue:name,publicPage:200,bundle,manifest:'correct',icons:'valid PNG sizes',bookingDestination:'correct venue'})
}
assert.equal(results[0].bundle,results[1].bundle)
fs.writeFileSync('artifacts/live-public-smoke.json',JSON.stringify({checked:new Date().toISOString(),results},null,2))
console.log(JSON.stringify({passed:true,results}))
