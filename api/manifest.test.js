import { it,expect,vi,afterEach } from 'vitest'
import handler from './manifest'
afterEach(()=>vi.unstubAllGlobals())
it('retains Appleton install identity when the database is down',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Offline')))
 let result;const headers={};const res={setHeader(k,v){headers[k]=v},status(){return this},json(v){result=v}}
 await handler({headers:{host:'appleton-app.vercel.app'}},res)
 expect(result.name).toBe('Appleton Indoor Golf');expect(result.icons.every(i=>i.src.includes('/appleton-'))).toBe(true);expect(headers['Cache-Control']).toContain('no-cache')
})
