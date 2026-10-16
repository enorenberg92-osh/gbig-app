export const userId = '00000000-0000-4000-8000-000000000001'
export const venueId = '00000000-0000-4000-8000-000000000002'
export const senderId = '00000000-0000-4000-8000-000000000003'
export const state = { authenticated: true, admin: true, assigned: true, storage: true, calls: [] as string[], campaign: null as any }
export function reset() { Object.assign(state, { authenticated: true, admin: true, assigned: true, storage: true, calls: [], campaign: null }) }

export function createClient(..._args: unknown[]): any {
  return {
    auth: { getUser: (..._args: unknown[]) => Promise.resolve({ data: { user: state.authenticated ? { id: userId } : null }, error: state.authenticated ? null : { message: 'invalid' } }) },
    from(table: string) {
      state.calls.push(table)
      let operation = 'select', inserted: any
      const result = () => {
        if (table === 'location_admins') return { data: state.admin ? { user_id: userId } : null, error: null }
        if (table === 'super_admins') return { data: null, error: null }
        if (table === 'weekly_email_senders') return { data: [{ id: senderId, location_id: venueId, display_name: 'Trent', email: 'trent@greenbayindoorgolf.com', reply_to: 'trent@greenbayindoorgolf.com', enabled: true, is_default: true }], error: null }
        if (table === 'weekly_email_sender_users') return { data: state.assigned ? [{ user_id: userId, sender_id: senderId }] : [], error: null }
        if (table === 'weekly_email_direct_quota') return { data: [], error: null }
        if (table === 'weekly_email_campaigns') {
          if (!state.storage) return { data: null, error: { message: 'missing' } }
          if (operation === 'insert') state.campaign = inserted
          return { data: state.campaign, error: null }
        }
        throw new Error(`Unexpected database access: ${table}`)
      }
      const builder: any = {
        select: () => builder, eq: () => builder, limit: () => builder, order: () => builder,
        insert(value: any) { operation = 'insert'; inserted = value; return builder },
        maybeSingle: () => Promise.resolve(result()), single: () => Promise.resolve(result()),
        then(resolve: any, reject: any) { return Promise.resolve().then(result).then(resolve, reject) },
      }
      return builder
    },
  }
}
