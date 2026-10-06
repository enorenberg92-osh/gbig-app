import React, { createContext,useContext,useEffect,useState } from 'react'
import { supabase } from '../lib/supabase'
import { hostSlug,validCachedLocation,resolveLocation,VENUES } from '../lib/locationIdentity'
const LocationContext=createContext(null)
const hostname=window.location.hostname.toLowerCase(),slug=import.meta.env.DEV?null:hostSlug(hostname),cacheKey=`loc:${hostname}`
function cachedLocation(){try{const value=JSON.parse(localStorage.getItem(cacheKey));return validCachedLocation(value,slug)?value:null}catch{return null}}
export function LocationProvider({children}){
 const [resolved,setResolved]=useState(cachedLocation),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 const fallbackId=import.meta.env.VITE_LOCATION_ID
 useEffect(()=>{let cancelled=false;setError('');resolveLocation(supabase,{slug,fallbackId,cached:cachedLocation()}).then(data=>{if(cancelled)return;setResolved(data);try{localStorage.setItem(cacheKey,JSON.stringify(data))}catch{}}).catch(e=>{if(!cancelled)setError(e.message)});return()=>{cancelled=true}},[fallbackId,retry])
 const appName=resolved?.name || VENUES[slug]?.name || 'Golf League App'
 if(!resolved?.id)return <main style={{padding:24,maxWidth:480,margin:'auto'}}><h1>{appName}</h1><p role={error?'alert':'status'}>{error || 'Loading your venue…'}</p>{error&&<button onClick={()=>setRetry(n=>n+1)}>Try again</button>}</main>
 return <LocationContext.Provider value={{locationId:resolved.id,appName,appFullName:appName,timezone:resolved.timezone || 'America/Chicago',location:resolved}}>{children}</LocationContext.Provider>
}
export function useLocation(){const value=useContext(LocationContext);if(!value)throw new Error('useLocation must be used inside LocationProvider');return value}
