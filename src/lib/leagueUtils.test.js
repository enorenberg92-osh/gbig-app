import { it, expect } from 'vitest'
import { loadActiveRound } from './leagueUtils'

function client(events, error=null) {
  return {from(table){const filters={};return {
    select(){return this},eq(key,value){filters[key]=value;return this},order(){return this},limit(){return this},
    maybeSingle(){return Promise.resolve(table==='league_config' ? {data:{id:'winter'}} : {data:events.find(e=>Object.entries(filters).every(([key,value])=>e[key]===value))||null,error})},
  }}}
}
it('ignores an older session open round when the working winter session starts', async()=>{
  const rows=[{id:'old',location_id:'venue',league_id:'fall',status:'open',week_number:1},{id:'new',location_id:'venue',league_id:'winter',status:'open',week_number:1}]
  expect((await loadActiveRound(client(rows),'venue')).id).toBe('new')
  expect(await loadActiveRound(client(rows.slice(0,1)),'venue')).toBe(null)
})
it('a failed active-round query is an error, not a false no-active-round result', async()=>{
  await expect(loadActiveRound(client([],{message:'offline'}),'venue')).rejects.toEqual({message:'offline'})
})
