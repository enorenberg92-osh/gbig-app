BEGIN;
-- No OAuth credentials or refresh tokens are exposed through browser roles.
CREATE TABLE public.gmail_email_connections (
  sender_id uuid PRIMARY KEY REFERENCES public.weekly_email_senders(id),
  mailbox text NOT NULL CHECK (char_length(mailbox) BETWEEN 3 AND 254),
  google_subject text NOT NULL,
  refresh_token_ciphertext text NOT NULL CHECK (refresh_token_ciphertext LIKE 'v1.%'),
  connected_by uuid NOT NULL REFERENCES auth.users(id),
  connected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.gmail_email_oauth_states (
  state_hash text PRIMARY KEY,
  sender_id uuid NOT NULL REFERENCES public.weekly_email_senders(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  verifier_ciphertext text NOT NULL CHECK (verifier_ciphertext LIKE 'v1.%'),
  return_origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX gmail_email_oauth_user_expiry ON public.gmail_email_oauth_states(user_id, expires_at);
CREATE INDEX gmail_email_oauth_sender ON public.gmail_email_oauth_states(sender_id);
CREATE INDEX gmail_email_connected_by ON public.gmail_email_connections(connected_by);
ALTER TABLE public.gmail_email_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gmail_email_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gmail_email_connections, public.gmail_email_oauth_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.gmail_email_connections, public.gmail_email_oauth_states TO service_role;
COMMENT ON TABLE public.gmail_email_connections IS 'Private AES-GCM encrypted Gmail refresh tokens bound to a sender and exact verified mailbox. No sender activation or role grants occur during OAuth.';
COMMENT ON TABLE public.gmail_email_oauth_states IS 'Single-use hashed OAuth state with encrypted PKCE verifier and a ten-minute lifetime. Callback rechecks current sender assignment and venue administration.';
COMMIT;
