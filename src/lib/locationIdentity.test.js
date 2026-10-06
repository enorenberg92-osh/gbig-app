import { describe,it,expect } from 'vitest'
import { hostSlug,resolveLocation,validCachedLocation } from './locationIdentity'
const client=(response,lookups=[])=>({from(){return{select(){return this},eq(field,value){lookups.push([field,value]);return this},maybeSingle(){return Promise.resolve(response)}}}})
describe('venue identity',()=>{
 it('maps app addresses and development',()=>{expect(hostSlug('appleton-app.vercel.app')).toBe('appleton');expect(hostSlug('gbig-app.vercel.app')).toBe('gbig');expect(hostSlug('localhost:5173')).toBe(null)})
 it('recognizes a venue on Vercel preview deployments',()=>{expect(hostSlug('gbig-app-abcdef-project.vercel.app')).toBe('gbig');expect(hostSlug('appleton-app-git-review-project.vercel.app')).toBe('appleton');expect(hostSlug('gbig-44q362oj4-enorenberg92-oshs-projects.vercel.app')).toBe('gbig');expect(hostSlug('appleton-git-review-project.vercel.app')).toBe('appleton')})
 it('rejects another venue cache',()=>{expect(validCachedLocation({id:'gb',slug:'gbig'},'appleton')).toBe(false)})
 it('never falls back after an Appleton failure',async()=>{const calls=[];await expect(resolveLocation(client({error:{message:'Offline'}},calls),{slug:'appleton',fallbackId:'gb'})).rejects.toThrow('Offline');expect(calls).toEqual(Array(3).fill(['slug','appleton']))})
 it('uses matching cache during outage',async()=>{const cached={id:'a',slug:'appleton'};expect(await resolveLocation(client({error:{message:'Offline'}}),{slug:'appleton',cached})).toBe(cached)})
 it('unknown host is a configuration error',async()=>{await expect(resolveLocation(client({data:null}),{slug:'unknown',fallbackId:'gb'})).rejects.toThrow('not configured')})
})
