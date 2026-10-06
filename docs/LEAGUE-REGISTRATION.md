# League registration

Staff verifies the venue, working session, names, partners, emails and whole-number 9-hole handicaps before importing. In Players & Teams, choose Import, upload the roster CSV, review the partnerships, check the verification box, and choose **Import and register**.

Each valid partnership is saved in one transaction. A failure creates no partial team or unassigned golfers. Re-importing an unchanged partnership reuses its players and team. Existing golfers matched by email must also have the same name; conflicting identities, partners or handicaps require staff review rather than a silent overwrite. Phone and day/time details are retained.

Registration creates new app accounts automatically with the golfer's email and lowercase `password`. Existing app accounts retain their passwords. A website tee-time account may be separate. There is no self-signup or activation link for players to complete.

The welcome email includes the session name, the correct venue's app link, login instructions, a short first-visit guide, and instructions to add the app to the phone's home screen. Replies go to Trent for Green Bay and Jordan for Appleton.

For a roster already entered, staff can check the **verified roster** box and choose **Register verified roster**. This queues only current partnerships in the selected session. It does not import last year's spreadsheet automatically.

## Exceptions and retries

- Missing or malformed email: the player stays on the roster, with no account or welcome until staff corrects the email and retries.
- Shared email: use a different email for each golfer. The app expects one golfer per account per venue.
- Existing account: link the existing account and tell the player to use their current app password.
- Email service unavailable: app access can still become ready. The screen reports that the welcome email is waiting, not sent.
- Interrupted import or registration: reopen Import to see persisted registration status and choose **Retry pending registrations** after verifying the current roster. A recorded successful welcome is skipped.
- An uncertain email send older than 23 hours requires checking the email provider log before sending again. The app does not automatically risk a duplicate welcome outside the provider's 24-hour idempotency window.

New-session registrations have their own welcome records. Previous sessions' account passwords and recorded welcome statuses are preserved.

## One-time email setup

The sending adapter uses Resend. Connect an existing account if one is available. Otherwise the owner completes account creation and any paid-plan selection. Verify `greenbayindoorgolf.com` and `appletonindoorgolf.com` using the exact DNS records Resend supplies; preserve the existing records used for regular business email.

Create a sending-only API key and store it as the Supabase Edge Function secret `RESEND_API_KEY`. Never put it in the app's frontend environment or paste it into chat. The welcome senders are `Trent <trent@greenbayindoorgolf.com>` and `Jordan <jordan@appletonindoorgolf.com>`, with those same reply addresses. The canonical app links are `https://gbig-app.vercel.app/league` and `https://appleton-app.vercel.app/league`.

Choose sending capacity for both venues' full rosters. Resend's free plan is limited to 100 emails per day, so a 300-player welcome run needs a higher limit or a deliberate multi-day rollout. Source: https://resend.com/pricing (checked October 6, 2026).

Deploy migration `202610060003_league_onboarding.sql`, then deploy `league-onboarding`, `register-import-team` and `create-player-account` with `--no-verify-jwt`. Each function validates the caller's JWT with `getUser`; the import RPC and onboarding handler enforce venue staff authorization. The server starts registration as each partnership is saved. Publish the frontend after the backend is ready.

Before registering real golfers, send and inspect a welcome to an owner-authorized test address after domain verification. Confirm sender, reply address, venue link, new-versus-existing password instructions and inbox receipt. A provider acceptance response is not proof of inbox delivery.
