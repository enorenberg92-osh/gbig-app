# Email: staff use and one-time owner setup

This feature provides separate direct email and pre-close weekly email workflows. See WEEKLY-EMAIL-VERIFICATION.md for the current release record. No real validation emails have been sent.

## Guided owner setup inside the app

Open **Email → Owner setup · four simple steps**. The interactive guide walks through connection checks, explicit sender access, domain verification, and one approved private delivery test. **Refresh readiness** shows storage, sender-access, and server-key presence separately. No setup action sends mail or changes permissions.

The guide provides a copyable setup request containing this venue's ID and the account ID confirmed by the backend. A sender address never establishes account identity. Multiple senders and future venues use the same guide. Credentials are entered only in the secure provider dashboards. Domain verification and key validity remain owner checks; presence alone does not establish delivery readiness.

## Send yourself a test or email one person

1. Open **Email** in the venue's admin menu. No round or league is required.
2. Check **From**, enter one address in **To**, and type or paste **Subject** and **Message**. To test, enter your own exact email address. The app does not guess the owner's address.
3. Choose **Preview email**. Check the exact sender, recipient, subject, and message, then explicitly send to that one address.

This path never looks up the league roster and never sends a push notification. It can only send to one explicitly entered address. It is suitable for a private test or an ordinary individual message. A test is a real email to that address; previewing is not a send. Choose **New email** to deliberately start a different message after the current message finishes.

The initial sender defaults requested are:
- Green Bay: **Trent <trent@greenbayindoorgolf.com>**
- Appleton: **Jordan <jordan@appletonindoorgolf.com>**

The app shows only senders approved for your signed-in account at the current venue. If you have more than one approved sender, choose from the **From** dropdown. If there is one, it is selected for you. You cannot type an arbitrary From address. Having access at one venue does not grant access at another.

## Send the league's weekly email

This is a separate, intentional workflow:
1. Open the current round in **Overview** and choose **Weekly Email**.
2. Check From, enter the subject and message, and preview.
3. Check the server-confirmed roster recipient count and skipped-address count. Explicitly send to that audience. Continue additional batches if needed.

Each golfer gets a separate email, without other golfers' addresses. Only that open round's venue/league roster is used. Missing or invalid addresses are excluded and counted; shared addresses receive one copy. Correct player records and preview again before sending if everybody needs a copy.

Sending never closes a round or finalizes scores. Finish the league email before closing. The dashboard blocks closing when it knows a started email still has pending recipients. A different administrator can still close from another session; that cross-session operation is not transactionally locked with external email delivery. If that happens, ask the owner to review the partial send.

## If something goes wrong

**Accepted by email service** is not proof of inbox delivery or reading. Refresh status to recover recorded progress after a connection interruption. The direct composer saves only its opaque compose identifier in per-tab session storage scoped to the signed-in user and venue, so a refresh recovers that exact draft even if another tab created a newer message. Email content and recipient addresses are not stored there. Closing the tab or clearing its storage removes that pointer; this first version has no full direct-message history picker, so older unfinished messages may need owner/provider review if a newer message exists. If browser storage is blocked, the app warns that full-page recovery may fall back to the most recent direct message; use the saved message and provider history to resolve uncertainty before creating another. Retry the same saved email, not a new copy. The sender, recipient(s), and message are frozen once sending starts. Attempts older than the safe retry window require owner review in the provider history; the app refuses to blindly resend them.

If sender permission was removed or the configured address changed, further sending stops. The owner must review the saved email and permissions; the app never silently substitutes another sender. One league email is allowed per round. Additional individual messages require explicit New email.

## Owner: one-time setup

Ordinary staff do not need API keys, provider settings, DNS, or technical knowledge. An owner/app maintainer performs this initial setup once. The in-app guide reports what still needs attention; check the verification record before applying a migration again.

### Safe values to copy

- Green Bay sender and reply address: `trent@greenbayindoorgolf.com`
- Green Bay domain: `greenbayindoorgolf.com`
- Appleton sender and reply address: `jordan@appletonindoorgolf.com`
- Appleton domain: `appletonindoorgolf.com`
- Server function: `weekly-email`
- Server secret name: `RESEND_API_KEY` (name only; not a key value)

Do not paste credentials into chat, the email editor, source code, or browser app variables. Reuse the existing server-side email key when authorized. If a key must be entered or changed, use the provider's secure dashboard yourself.

### Copy this handoff for your app maintainer

> Please review and install this Email patch in a test environment first. Confirm the correct existing backend; the repository setup guide alone is not proof of the live project's identity. Review docs/proposed-sql/weekly-email.sql, create a migration with the Supabase CLI, and apply it only after approval. Deploy weekly-email with authenticated-user JWT verification enabled. Reuse the existing RESEND_API_KEY server secret, never a VITE variable. Verify both sending domains in Resend. Assign only the specifically approved existing staff account IDs to the allowed venue senders, then enable those sender records. Deploy the frontend. Validate authorization, concurrency, retries and direct-versus-league separation with mocked email delivery. Obtain explicit approval before a real test email or production rollout.

The email migration adds four private tables: venue sender settings, explicit user-to-sender assignments, send history, and a direct-email daily allowance ledger. All have row-level security and no direct anonymous or signed-in browser access. The service role can read settings/assignments, read/insert/update send history, and read/insert allowance reservations; it cannot use this endpoint to manage permissions. Existing tables, onboarding, and push-notification settings are unchanged. Applying this security configuration requires owner approval.

The initial Trent and Jordan configurations are inserted **disabled**. No account permissions are guessed from display names or sender email addresses. The maintainer must confirm the actual existing signed-in staff identities and which sender each may use. Both existing venue-admin authority and the explicit sender assignment are required, even for a super-admin.

### Verify the domains

Open [Resend Domains](https://resend.com/domains) and check **greenbayindoorgolf.com** and **appletonindoorgolf.com**. If already verified for the existing service, do not create duplicates or alter onboarding senders. Confirm the existing sending key can use them.

If a domain is unverified, its owner must copy the exact DNS records displayed by Resend into that domain's DNS provider. These account-specific values cannot be guessed. Do not change unrelated mail/MX records. Domain or credential changes require owner approval.

### New locations and multiple senders

No application code rewrite is needed for another venue. After approved setup, the maintainer adds a sender setting tied to that location's existing ID, verifies its domain, marks the venue's usual sender as default, and explicitly assigns the authorized staff account IDs. Enable the sender only when ready. At most one default exists per venue. Staff with several permitted senders see a dropdown; staff with only one see that sender automatically. Unauthorized senders are never offered or accepted by the backend.

A sender change does not rewrite an email already being sent. Pending sends stop for review if the saved sender no longer matches the enabled configuration. Disable sender records or remove assignments to prevent future sends, under the owner's approved access-change process. This patch does not include a staff permission-management screen.

### Check setup

The app checks that approved sender configuration, the private history table, and a service key are present. It does not expose credentials or send a test email. It explicitly does not prove key validity, live domain verification, sending limits, or delivery.

- **Approve a sender for your account:** owner checks the explicit assignment and enabled venue sender.
- **Approved sender setup could not be checked:** maintainer checks the new settings tables and backend permissions.
- **Email history storage could not be checked:** maintainer checks the ledger migration and permissions.
- **Connect email service:** owner checks the existing server secret.
- **Configuration present:** the owner must still verify the domain and approve any real test.

## Maintainer notes and verification limits

Baseline: `d38bb8aeb55772026f4c7dcfbbde3f7fb85b5e40`.

Every request validates a live authenticated user with auth.getUser, then checks the requested event/location's existing venue-admin authority. Sender assignments are separate and explicit; client-provided From is ignored. Direct messages require a location and one validated To address; they never require/query an event, league or roster. Direct saved-message access is limited to the creating user and venue. League mode derives its audience from the current round's historical roster and venue-filtered records.

Direct messages use a unique compose ID; league messages use a unique event. Preview edits invalidate old draft IDs. Atomic lease claims and fenced writes serialize send requests. A durable attempt record precedes each provider call; immutable sender/recipient/content and stable per-recipient provider keys make retries safe inside the provider window. After 23 hours uncertain attempts stop for review. Accepted messages are skipped on retry. Each request is bounded to 90 KB, subject 200 characters, message 20,000 characters, and ten provider calls. League rosters are limited to 500 and direct emails to one address. New direct send attempts are additionally capped at 50 per signed-in user per venue per UTC day. Unique database slots enforce this even under concurrent requests. Retries of the same started email do not consume more allowance. If the cap is reached, the error gives the next midnight UTC reset. Provider limits still apply. Reservations abandoned before sending still consume a slot for that day; there is no client quota-reset endpoint.

No notification function is imported or invoked. No sending action updates a round. The existing welcome-email configuration for Trent and Jordan is unchanged.

Required before production: local/staging database and endpoint tests for auth, per-user sender grants, cross-location denial, direct isolation, concurrent previews/leases, database-write/provider interruptions, permission revocation, refresh recovery and closed-round handling. The original V2 package did not verify live integration, Deno types, browser QA, provider readiness, or delivery. The current integration record is in WEEKLY-EMAIL-VERIFICATION.md. See the separate verification record and final test counts.

References: [Supabase auth](https://supabase.com/docs/guides/functions/auth), [Resend send API](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
