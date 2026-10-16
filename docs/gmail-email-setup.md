# Gmail delivery for direct and weekly emails

This uses the existing Gmail mailboxes whose Google sign-in addresses are
`trent@greenbayindoorgolf.com`, `erich@greenbayindoorgolf.com`, and
`jordan@appletonindoorgolf.com`. The owner confirmed these exact addresses.
DNS changes are prohibited. Do not resume the historical Resend DNS setup.

## Google app registration

Use a dedicated, owner-approved Google Cloud project and enable Gmail API.
Register a Web application OAuth client named **GBIG AIG Gmail Sender** with
this exact redirect URI:

`https://mtuzmasicpcxcvtslevm.supabase.co/functions/v1/gmail-oauth`

The app requests only `openid`, `email`, and
`https://www.googleapis.com/auth/gmail.send`. Do not add inbox-reading,
draft-management, full-mail, domain-wide delegation, or Cloud Platform scopes.
Google may require Workspace administrator approval and OAuth verification,
depending on the chosen audience and publishing configuration. Do not bypass
warnings or describe testing configuration as production-ready. External apps
in Testing receive Gmail refresh tokens that expire after seven days.

The setup owner configures these server-only Supabase Edge Function secrets:

| Name | Value |
| --- | --- |
| `GMAIL_CLIENT_ID` | The approved Google web client ID |
| `GMAIL_CLIENT_SECRET` | That client's secret |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Base64 of 32 cryptographically random bytes |

Never paste credentials into chat, source control, frontend configuration, or
the email composer. Never print credential values in logs. Keep the encryption
key stable; rotating it requires reconnecting existing Gmail accounts.

The approved Google project is **GBIG AIG Email** (`gbig-aig-email`), project
number `103251787602`. Gmail API is enabled. Google initially attached billing
automatically; the owner approved removing that attachment, and billing is
disabled for this project.

Before moving an External OAuth app to Production, publish owner-reviewed
application information, privacy, and use terms. The prepared pages are
`/email-about.html`, `/email-privacy.html`, and `/email-terms.html`; Gmail setup
links to these disclosures before the user connects. Google may also require
domain ownership checks and app verification. Do not change DNS to satisfy
these requirements: DNS changes are prohibited. Use an authorized non-DNS
verification method if available, or report the blocker.

The owner must approve privacy/use commitments before publishing these pages.
Publishing OAuth configuration does not enable an app sender or approve a send.

## Backend deployment

Apply migration `20261016212050_gmail_email`. Both added tables have RLS,
no browser grants, and only server-side service-role access. Refresh tokens
use AES-256-GCM with sender/mailbox binding; PKCE verifiers are encrypted too.
OAuth state is stored as a hash, expires after ten minutes, and is consumed
atomically once before token exchange. Current venue administration and exact
sender assignments are checked at start and again during callback completion.

Deploy `gmail-oauth` with `verify_jwt=false` for Google's GET redirect. This is
not an anonymous connection API: POST validates Supabase `auth.getUser`, a
production app Origin, and current sender permissions; GET requires single-use
state and PKCE, exact verified Google mailbox identity, and current permissions.
Callback return URLs are limited to the two production app origins.

Deploy `weekly-email` with `verify_jwt=true`. It also verifies `auth.getUser`.
Its direct/weekly delivery uses Gmail exclusively. The separate pre-existing
`league-onboarding` function still uses its original Resend implementation and
is outside this Gmail composer change; it is not made email-ready by this work.

## Connect, activate, test

In each production app's Email tab, use **Connect Gmail** for the exact approved
mailbox. The mailbox owner grants sending access in Google's screen. Connecting
does not assign app roles, enable a sender, or send email. An enabled sender
and an exact matching saved Gmail connection are both required for sending.
Existing owner/staff sender assignments remain authoritative.

Sender activation still needs separate owner approval. A live delivery test
requires approval of exact From, recipient addresses, subject, and complete message.
Use direct email only for validation. Never send to the league roster as a test.

Gmail has no Resend-style provider idempotency key. Progress is saved before
calling Gmail; an uncertain attempt or interrupted write moves that recipient
to review and never resends it automatically. The owner checks the sender's
Sent mail before approving a replacement. The app supplies a stable Message-ID,
but Gmail can rewrite it: the live private delivery test returned a different
RFC Message-ID. Review sender, recipient, subject, send time, and saved provider
message ID rather than relying on the submitted Message-ID. Neither identifier
is claimed to provide Gmail deduplication.

Saved configuration and Gmail API acceptance are distinct from a confirmed
recipient inbox result. Gmail account quotas and organization policies apply.

## Multiple direct recipients

The regular Email tab is available any time, without an open round, week, or
closing workflow. It accepts up to 1,000 unique addresses, separated by
commas, semicolons, or new lines. Addresses are normalized and deduplicated;
any invalid address blocks preview of the entire list. Preview displays every
address and its total before sending. Each recipient receives a separate Gmail
message with only their own address in To. No shared To, CC, or BCC list is used.

Choose **Choose venue or league members**, select a group, and use **Add whole
league to To** or **Add all venue members to To**. League groups use that venue's
current teams and their active players; they do not use a historical round roster.
All-venue groups use active player records at the current venue. Missing/invalid
addresses are counted, and shared addresses are deduplicated. Contacts are paged
in stable ID order so groups larger than a single API page are not truncated.
You can edit To and paste extra addresses before previewing. Loading a group
does not send or implicitly add anyone to a later saved audience.

One Send click processes the saved list in batches of at most ten. An error or
uncertain attempt stops automatic continuation; refresh status before continuing
the untouched recipients. Accepted and uncertain recipients are never resent.

**Pause after this batch** saves progress and stops further batches. Use **New
email** to compose another message while an earlier saved message is unfinished;
**Saved emails** lists your latest 100 emails at this venue and opens the exact
compose ID without sending. A resume still requires an explicit Continue click.
Large sends require this browser page to stay open; a closed page does not run
an unattended worker. Reload or use Saved emails to recover and continue.

Apply anytime_bulk_email before deploying the updated function and frontend.
The app's former 50/day cap is retired; its private quota ledger is preserved
as history and the service role can no longer insert into it. Google mailbox
limits still apply, including sending outside this app. Paid Workspace accounts
typically allow 2,000 messages per rolling 24 hours; trials can be lower. Private
copies each count as a message. No billing or account quota changes are made.

The sender-batch RPC uses a transaction advisory lock and campaign leases so
different campaigns or users cannot run parallel batches through the same
sender. Each provider attempt is durably recorded first; the batch pauses 1.1
seconds after each successful send. This pacing accounts for Google's current
6,000 units/user/project/minute and 100 units per messages.send for newer
projects. RPCs remain service-role-only, with no browser execution grants.
Sender permissions and Google connection scopes are unchanged.

## Validation

- `npm test -- --maxWorkers=2 --minWorkers=1`
- `npm run build`
- `npm run test:email:database`
- `deno check supabase/functions/weekly-email/index.ts supabase/functions/gmail-oauth/index.ts`
- `deno test --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,GMAIL_CLIENT_ID,GMAIL_CLIENT_SECRET,GMAIL_TOKEN_ENCRYPTION_KEY --config scripts/email-runtime/deno.json scripts/email-runtime/check.ts`

Runtime tests stub Google and Supabase; database checks use disposable PGlite.
Neither sends email. PGlite's single connection is not proof of live
multi-session concurrency.

References: [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).
See also [Gmail API quotas](https://developers.google.com/workspace/gmail/api/reference/quota)
and [Workspace sending limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace).
