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
requires approval of exact From, one To address, subject, and complete message.
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
