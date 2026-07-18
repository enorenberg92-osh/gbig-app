-- Phase 5.2: money list (ledger only — no payment processing).
-- Sign convention: positive amount = credit to the player/team (they are owed:
-- skins, prizes, match points); negative = money out (payout made) or money
-- owed to the league (entry fee charged as negative until paid... simplest:
-- entry_fee entries are negative charges, payout entries negative, winnings
-- positive; a player's balance is just SUM(amount)).
-- Admin-only reads (money stays off player screens for now), writes via
-- audited RPCs, feature-gated on 'money'.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES public.locations(id),
  league_id UUID,
  event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  team_id UUID REFERENCES public.teams(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('entry_fee', 'skins', 'match_points', 'event_prize', 'payout', 'adjustment')),
  amount NUMERIC NOT NULL,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_league_idx ON public.ledger(location_id, league_id);
CREATE INDEX IF NOT EXISTS ledger_player_idx ON public.ledger(player_id);

ALTER TABLE public.ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ledger: admins read" ON public.ledger;
CREATE POLICY "ledger: admins read" ON public.ledger
  FOR SELECT TO authenticated USING (public.is_admin_of_location(location_id));

REVOKE ALL ON public.ledger FROM anon;
GRANT SELECT ON public.ledger TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_add_ledger_entries(p_league_id UUID, p_entries JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  entry JSONB;
  inserted INTEGER := 0;
  entry_player UUID;
  entry_team UUID;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  PERFORM public.require_feature_enabled(league_row.location_id, p_league_id, 'money');
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'entries must be a non-empty JSON array';
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    IF entry->>'type' NOT IN ('entry_fee', 'skins', 'match_points', 'event_prize', 'payout', 'adjustment') THEN
      RAISE EXCEPTION 'Invalid ledger type: %', entry->>'type';
    END IF;
    IF (entry->>'amount')::numeric IS NULL OR (entry->>'amount')::numeric = 0 THEN
      RAISE EXCEPTION 'Each entry needs a non-zero numeric amount';
    END IF;
    entry_player := NULLIF(entry->>'player_id', '')::uuid;
    entry_team   := NULLIF(entry->>'team_id', '')::uuid;
    IF entry_player IS NULL AND entry_team IS NULL THEN
      RAISE EXCEPTION 'Each entry needs a player or a team';
    END IF;
    IF entry_player IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.players WHERE id = entry_player AND location_id = league_row.location_id
    ) THEN RAISE EXCEPTION 'Player is not in this location'; END IF;
    IF entry_team IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.teams WHERE id = entry_team AND location_id = league_row.location_id
    ) THEN RAISE EXCEPTION 'Team is not in this location'; END IF;

    INSERT INTO public.ledger (
      location_id, league_id, event_id, player_id, team_id, type, amount, note, created_by
    ) VALUES (
      league_row.location_id, p_league_id,
      NULLIF(entry->>'event_id', '')::uuid,
      entry_player, entry_team,
      entry->>'type', (entry->>'amount')::numeric,
      NULLIF(trim(entry->>'note'), ''), auth.uid()
    );
    inserted := inserted + 1;
  END LOOP;

  PERFORM public.write_audit_event(
    league_row.location_id, 'ledger.add', 'league_config', p_league_id,
    NULL, jsonb_build_object('entries', p_entries, 'inserted', inserted)
  );
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_ledger_entry(p_entry_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE row_rec public.ledger%ROWTYPE;
BEGIN
  SELECT * INTO row_rec FROM public.ledger WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(row_rec.location_id);
  DELETE FROM public.ledger WHERE id = p_entry_id;
  PERFORM public.write_audit_event(row_rec.location_id, 'ledger.delete', 'ledger', p_entry_id, to_jsonb(row_rec), NULL);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_add_ledger_entries(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_ledger_entry(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_ledger_entries(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_ledger_entry(UUID) TO authenticated;

COMMIT;
