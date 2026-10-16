export const userId = '00000000-0000-4000-8000-000000000001'
export const venueId = '00000000-0000-4000-8000-000000000002'
export const senderId = '00000000-0000-4000-8000-000000000003'
export const state = { authenticated: true, admin: true, assigned: true, storage: true, connected:true, enabled:true, calls: [] as string[], campaign: null as any, oauthStates:[] as any[], connection:null as any, contacts:[] as any[], teams:[] as any[], leagues:[] as any[] }
export function reset() { Object.assign(state, { authenticated: true, admin: true, assigned: true, storage: true, connected:true, enabled:true, calls: [], campaign: null, oauthStates:[], connection:null,contacts:[],teams:[],leagues:[] }) }

export function createClient(..._args: unknown[]): any {
  return {
    rpc(name:string,args:any) {
      state.calls.push(name)
      if(name==='list_email_history') return Promise.resolve({data:[],error:null})
      if(name==='claim_email_send_batch')return {maybeSingle:()=>{if(state.campaign)Object.assign(state.campaign,{lease_token:args.claim_token,started_at:new Date().toISOString()});return Promise.resolve({data:state.campaign,error:null})}}
      if(name==='save_email_send_progress')return {maybeSingle:()=>{Object.assign(state.campaign,{recipients:structuredClone(args.new_recipients),last_error:args.new_error});return Promise.resolve({data:{id:args.target_campaign},error:null})}}
      throw new Error(`Unexpected RPC: ${name}`)
    },
    auth: { getUser: (..._args: unknown[]) => Promise.resolve({ data: { user: state.authenticated ? { id: userId } : null }, error: state.authenticated ? null : { message: 'invalid' } }) },
    from(table: string) {
      state.calls.push(table)
      let operation = 'select', inserted: any, one=false, offset=0, end=999
      const filters:((row:any)=>boolean)[]=[]
      const result = () => {
        if (table === 'location_admins') return { data: state.admin ? { user_id: userId } : null, error: null }
        if (table === 'super_admins') return { data: null, error: null }
        if (table === 'weekly_email_senders') {
          const rows=[{ id: senderId, location_id: venueId, display_name: 'Trent', email: 'trent@greenbayindoorgolf.com', reply_to: 'trent@greenbayindoorgolf.com', enabled: state.enabled, is_default: true }].filter(row=>filters.every(filter=>filter(row)))
          return {data:one?rows[0]||null:rows,error:null}
        }
        if (table === 'weekly_email_sender_users') return { data: one ? (state.assigned?{user_id:userId,sender_id:senderId}:null) : state.assigned ? [{ user_id: userId, sender_id: senderId }] : [], error: null }
        if(table==='gmail_email_connections'){
          if(operation==='upsert')state.connection=inserted
          const connection=state.connection||(state.connected?{sender_id:senderId,mailbox:'trent@greenbayindoorgolf.com'}:null)
          return {data:one?connection:connection?[connection]:[],error:null}
        }
        if(table==='gmail_email_oauth_states'){
          if(operation==='insert'){state.oauthStates.push(inserted);return {data:null,error:null}}
          const rows=state.oauthStates.filter(row=>filters.every(filter=>filter(row)))
          if(operation==='update')rows.forEach(row=>Object.assign(row,inserted))
          return {data:one?rows[0]||null:rows,error:null}
        }
        if (table === 'weekly_email_direct_quota') return { data: [], error: null }
        if(['players','teams','league_config'].includes(table)){
          const source=table==='players'?state.contacts:table==='teams'?state.teams:state.leagues
          const rows=source.filter(row=>filters.every(filter=>filter(row))).slice(offset,end+1)
          return {data:one?rows[0]||null:rows,error:null}
        }
        if (table === 'weekly_email_campaigns') {
          if (!state.storage) return { data: null, error: { message: 'missing' } }
          if (operation === 'insert') state.campaign = inserted
          if(operation==='update'&&state.campaign&&filters.every(filter=>filter(state.campaign)))Object.assign(state.campaign,inserted)
          return { data: state.campaign, error: null }
        }
        throw new Error(`Unexpected database access: ${table}`)
      }
      const builder: any = {
        select: () => builder, eq: (name:string,value:any) => {filters.push(row=>row[name]===value);return builder}, limit: () => builder, order: () => builder,
        in:()=>builder, range:(start:number,finish:number)=>{offset=start;end=finish;return builder}, is:(name:string,value:any)=>{filters.push(row=>(row[name]??null)===value);return builder}, gt:(name:string,value:any)=>{filters.push(row=>row[name]>value);return builder},
        insert(value: any) { operation = 'insert'; inserted = value; return builder },
        update(value:any){operation='update';inserted=value;return builder},upsert(value:any){operation='upsert';inserted=value;return builder},
        maybeSingle: () => {one=true;return Promise.resolve(result())}, single: () => {one=true;return Promise.resolve(result())},
        then(resolve: any, reject: any) { return Promise.resolve().then(result).then(resolve, reject) },
      }
      return builder
    },
  }
}
