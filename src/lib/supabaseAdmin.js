// ─────────────────────────────────────────────────────────────────────────────
//  DO NOT USE — intentionally neutralized.
//
//  This file previously exposed a service-role Supabase client via a VITE_
//  env var. Anything prefixed with VITE_ gets bundled into the browser, so a
//  service-role key here would grant full database access to every visitor.
//
//  Any privileged operation (creating auth users, sending pushes, etc.) MUST
//  happen inside a Supabase Edge Function with the caller's JWT. See:
//    - supabase/functions/create-player-account/index.ts
//    - supabase/functions/send-alert/index.ts
//    - supabase/functions/send-social-push/index.ts
//
//  If you find yourself needing admin-only DB work from the client, add a
//  new Edge Function — never re-introduce a browser-side service-role key.
// ─────────────────────────────────────────────────────────────────────────────

export const supabaseAdmin = null

if (import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY) {
  // eslint-disable-next-line no-console
  console.error(
    '[security] VITE_SUPABASE_SERVICE_ROLE_KEY is set. VITE_ env vars are ' +
    'bundled to the browser — remove this from every .env and rotate the key.'
  )
}
