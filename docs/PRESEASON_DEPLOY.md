# Pre-season deploy checklist (September 2026 review)

Order matters: the database goes first, then the edge functions, then the app.

## 1. Back up
Supabase dashboard → Database → Backups → confirm a recent backup exists (or take a `pg_dump`).

## 2. Database
Open the SQL editor and run the whole file `supabase/migrations/202609230001_review_fixes.sql`.
It runs as one transaction and is safe to re-run.

- If it errors, nothing is applied; send the error message along.
- It wipes `players.league_password` (plaintext passwords every player could read). Logins are unaffected, because those live in Supabase Auth.

## 3. Edge functions
```bash
supabase functions deploy create-player-account --project-ref mtuzmasicpcxcvtslevm --no-verify-jwt
supabase functions deploy send-alert            --project-ref mtuzmasicpcxcvtslevm
supabase functions deploy send-social-push      --project-ref mtuzmasicpcxcvtslevm
```

## 4. App
Merge the branch and let Vercel deploy. (The Handicap screen's "Recalculate All" needs step 2 first.)

## 5. Security follow-ups (do these before the season)
- **Reset passwords.** Anyone who could sign in could read every other player's password until step 2. Give each player a personal password with Players → edit → *Set login password*. Change the admin accounts' passwords first. Stop using one shared league password: anyone who knows it can sign in as anyone.
- Supabase → Authentication → Sign In / Providers: turn **off** "Allow new users to sign up" (accounts are created by admins) and keep "Confirm email" on.
- Run `select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by 1;` and look for leftover dashboard-created policies (anything not in the repo's migrations).
- Storage → `avatars` bucket: make sure uploads are restricted to signed-in users (ideally to their own file).
- If a `VITE_SUPABASE_SERVICE_ROLE_KEY` was ever deployed, rotate the service-role key.

## 6. After deploy
- Admin → Handicap → **Recalculate All**. Handicaps are now computed exactly (the old math dropped a stroke in some cases) over the most recent 12 rounds by date, so a few players may move by 1.
- Smoke test with a throwaway week:
  1. Player submits a score.
  2. Admin approves it.
  3. Publish the week.
  4. Check standings.
  5. Edit a score on the closed week.
  6. Send a test alert.
