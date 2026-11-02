# Sub requests and weekly score reminders

Admins receive a private message under **Alerts → Your account alerts** when a player requests a sub. Only admins assigned to that location receive the request. An unread badge appears on Alerts. The same message is queued for each admin's subscribed devices; enabling notifications while signed in links the device to that account. Existing subscriptions are relinked when the app opens after sign-in, and unlinked on sign-out.

**Admin → Subs → Add sub** lets an admin choose the open week, team, and player being covered, then choose an existing substitute or enter a new one. The assignment and substitute profile are approved in one transaction. An assignment does not change the team's permanent roster. Existing pending requests should be approved or denied before adding another assignment for the same player/week.

**Admin → Score reminders** configures one recurring weekday/time for the working league in the venue's time zone. Saving a new time replaces the previous active schedule. **Turn off** cancels future runs. Schedules do not automatically carry to a new season: configure the next working league explicitly.

At the scheduled time, the server reads that league's open playing week and historical roster, then creates private account messages only for players without a pending or verified `played` score. A substitute-covered score counts as entered; rejected scores and penalties do not. Closed weeks, future weeks, byes, archived leagues, and schedules created by a revoked location admin do not send. The next run is calculated in local time, including daylight saving changes. A delayed worker runs once and advances to the next future occurrence instead of sending a backlog.

Players without a linked app account cannot receive an account message; the last-run summary reports their count. The original rostered player's account receives the reminder for its roster slot. Private app messages remain available without phone permission. Phone delivery requires a subscribed device and operating-system permission; the worker checks missing scores again before sending to a phone. Last-run counts describe account messages created, not guaranteed phone deliveries.

## Runtime and deployment

Apply `20261101002412_location_subs_and_score_reminders.sql`, deploy `account-notifications`, provision the secrets below, then apply `20261101002745_notification_worker_schedule.sql`. The worker uses its own secret authentication and must be deployed with JWT gateway verification disabled. It accepts POST only and has no public recipient/message API.

- Edge secrets: existing `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL`; new random `NOTIFICATION_WORKER_SECRET`.
- Vault secrets: `notification_worker_url` = the project's `/functions/v1/account-notifications` URL; `notification_worker_secret` = the same worker secret.
- The `gbig-account-notifications` database cron job runs every minute. New account messages also wake the worker using `pg_net` after the transaction commits. Phone push failures never roll back the sub request.

Account messages and schedules enforce location/account permissions with RLS. Only service-role RPCs can process schedules and claim/finish deliveries; endpoint and retry data live in a non-exposed private schema. Claims expire after five minutes. Retry backoff is bounded to five attempts, expired devices are removed, and successful device endpoints are retained across retries. A process crash after a push is accepted but before completion is saved can deliver that push again; its stable notification tag replaces the earlier notification on supporting devices.

No schedule is enabled by deployment. Admins choose and save their own weekly time. Existing sub requests are not retroactively broadcast.

## Verification

`npm test` covers database authorization, account privacy, direct assignments and profiles, duplicate requests, missing-score selection, substitute-covered cards, rejected scores, byes/closed/future weeks, revoked admins, weekly replacement/cancellation, DST, idempotent scheduling, delivery leases, targeted devices, retries and expired subscriptions. `npm run test:database` checks the existing PostgreSQL contracts. `npm run build` validates the production frontend bundle.
