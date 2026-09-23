# Pre-season deploy checklist (September 2026)

Order matters: the database goes first, then the edge functions, then the app.

## 1. Back up
Supabase dashboard → Database → Backups → confirm a recent backup exists (or take a `pg_dump`).

## 2. Database
In the SQL editor, run each file in order. Each runs as one transaction and is safe to re-run; if one errors, nothing from that file is applied, so send the error along.

1. `supabase/migrations/202609230001_review_fixes.sql`: review fixes and security. It wipes `players.league_password` (plaintext passwords every player could read). Logins are unaffected, because those live in Supabase Auth.
2. `supabase/migrations/202609230002_live_rounds.sql`: live hole-by-hole rounds, the Tonight leaderboard, and sim ingest.
3. `supabase/migrations/202609230003_score_reminders.sql`: the weekly "Scores due" reminder.
4. `supabase/migrations/202609230004_season_archive.sql`: season archive.
5. `supabase/migrations/202609230005_signup_intake.sql`: website sign-up intake.

## 3. Edge functions
```bash
P=mtuzmasicpcxcvtslevm
supabase functions deploy create-player-account --project-ref $P --no-verify-jwt
supabase functions deploy send-alert            --project-ref $P
supabase functions deploy send-social-push      --project-ref $P
supabase functions deploy send-score-reminders  --project-ref $P
supabase functions deploy signup-webhook        --project-ref $P --no-verify-jwt
supabase functions deploy sim-ingest            --project-ref $P --no-verify-jwt
```
They use the existing `VAPID_*` secrets.

## 4. Schedule the weekly reminder (hourly job)
The function only sends at each location's configured day and hour; running it every hour is what lets that work.

- **Option A (dashboard):** Integrations → Cron → new job, schedule `0 * * * *`, Edge Function `send-score-reminders`, POST, header `Authorization: Bearer <service role key>`.
- **Option B (SQL):** enable the pg_cron and pg_net extensions first, then run:
  ```sql
  select vault.create_secret('<service role key>', 'service_role_key');
  select cron.schedule('send-score-reminders', '0 * * * *', $$
    select net.http_post(
      url := 'https://mtuzmasicpcxcvtslevm.supabase.co/functions/v1/send-score-reminders',
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key')),
      body := '{}'::jsonb, timeout_milliseconds := 30000);
  $$);
  ```

Use the legacy JWT service-role key, not a new-style `sb_secret_…` key.

## 5. App
Merge the branch and let Vercel deploy. The new `middleware.js` serves each location's own title and icon, and needs no configuration.

- Appleton (and any phone that installed the app before this deploy): delete the home-screen app and add it again from the location's link. On iPhone, use Safari: wait for the page to load, then Share → Add to Home Screen.

## 6. Supabase Auth settings (forgot password + security)
- **Authentication → URL Configuration:**
  - Site URL = the main domain.
  - Redirect URLs: add `https://gbig-app.vercel.app/**`, `https://appleton-app.vercel.app/**`, and every custom domain. A missing domain sends reset links to the wrong location.
- **Email Templates → Reset Password:** use location-neutral wording. Keep `{{ .ConfirmationURL }}`.
- **SMTP:** the built-in email only sends about 2–4 emails per hour. Set up custom SMTP (Resend or SendGrid) before the season, then raise the email rate limit.
- **Sign In / Providers:** turn **off** "Allow new users to sign up" (admins create accounts), and keep "Confirm email" on.

## 7. Security follow-ups
- **Reset passwords.** Anyone signed in could read every other player's password until step 2 ran. Change the admin passwords first. Stop using one shared league password: anyone who knows it can sign in as anyone. Players can now use **Forgot password?** themselves.
- Run `select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by 1;` and look for leftover dashboard-created policies (anything not in the repo's migrations).
- Storage → `avatars` bucket: restrict uploads to signed-in users.
- If a `VITE_SUPABASE_SERVICE_ROLE_KEY` was ever deployed, rotate the service-role key.

## 8. Website sign-ups (per location)
Admin → Sign-ups → **Generate key** → copy the URL → WPForms → Settings → Webhooks: POST, JSON, with these field keys:

- `p1_name`, `p1_email`, `p1_phone`, `p1_handicap`
- `p2_name`, `p2_email`, `p2_phone`, `p2_handicap`
- `day`, `time`, `message`
- `team_name` (optional)

Send a test entry. No Webhooks addon on your plan? Zapier or Make "POST to URL" with the same keys works too.

## 9. After deploy
- Admin → Handicap → **Recalculate All**. Handicaps are now computed exactly (the old math dropped a stroke in some cases) and ordered by event date, so a few players may move by 1.
- Admins: turn on notifications (Alerts tab) on your phone, so you get sign-up pings.
- Check Admin → Alerts → Weekly Scores Reminder (default Friday 9 AM, teams that haven't submitted).
- Archive last season's league (Admin → Leagues) so it shows in the Standings history.
- Enable GitHub Actions on the repo. The CI workflow runs the unit tests, the build, and the database suite on every push.
- Smoke test with a throwaway week:
  1. A player enters holes; the Tonight leaderboard updates.
  2. The player submits the round.
  3. An admin approves it.
  4. Publish the week and check standings.
  5. Edit a score on the closed week.
  6. Send a test alert and a test reminder.
