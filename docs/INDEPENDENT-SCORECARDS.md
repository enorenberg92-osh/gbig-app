# Independent partner scorecards

Implementation and review are complete. Migration `20261020005345_independent_partner_scores.sql` has been applied and verified on production Supabase project `mtuzmasicpcxcvtslevm`. The shared frontend release is tracked in [PR 13](https://github.com/enorenberg92-osh/gbig-app/pull/13); use its production deployment status to confirm availability.

## Player and staff workflow

1. Open Score Entry during the normal open round. The signed-in golfer's unsubmitted card is selected by default. Select the partner too to enter both cards together, or select only the partner when recording their round for them.
2. Enter every hole for each selected golfer, then submit. Each selected card must be complete; an unfinished partner card does not block a complete selected card. Optional hole stats remain optional.
3. A saved card is locked in player score entry and shows its own total and review status. The other partner can submit separately while the same round remains open. Independent entry does not extend the deadline or reopen a closed event.
4. Staff review each pending score through the existing Scores workflow. The event summary counts teams with **both scores** and separately identifies teams awaiting a partner. A one-card team shows **1 of 2 scorecards submitted** and the missing partner's name instead of a combined team total. Both cards saved does not mean both are approved.
5. Resolve pending reviews and missing scores through the existing admin correction and league closeout process. Publishing rules and missing-round handling remain in force.

For an ordinary save error, correct the reported issue or restore connectivity and retry. Drafts remain on the device. If the app says submission could not be confirmed, use **Refresh submitted cards** before retrying: the server may already have accepted the card. Refreshed saved cards take precedence over local values, including their totals. A retry preserves an existing non-rejected card rather than overwriting it.

If staff reject a score, refresh or reopen score entry to see that golfer as unsubmitted. Re-enter the complete corrected card and submit while the round is open. Ask staff for a correction when the round is closed or a saved card needs changing.

## Draft and score preservation

- Unsent partner scores and stats survive another golfer's successful submission. Drafts remain device-local, scoped by account, location, league, event and team, and mapped by golfer ID rather than roster order. They do not sync to a partner's device or another domain's browser storage. Course or roster incompatibility still prevents restoring an invalid draft.
- Submitted server cards override only that golfer's draft. The remaining draft is cleared when both cards are saved. Browser storage restrictions or cleared browser data retain their existing limits; see [unfinished scorecards](SCORECARD-DRAFTS.md).
- The migration replaces `submit_scores` to accept a nonempty subset of the caller's dated team roster. It changes no existing score rows. Authentication, venue and roster checks, complete-card validation, optional-stat validation, event locking against publishing, pending review, audit logging and insert-only conflict handling are retained. Accepted rows retain their stored handicap snapshots.
- This is a narrow **Operate** extension of the incumbent interface. Existing green/white styling, hole controls, navigation and surrounding league flows remain. It establishes no replacement product or global visual system. Existing source behavior, historical migrations and tests remain in place, with targeted regression coverage added.

## Release order

1. Confirm the existing production Supabase project is **`mtuzmasicpcxcvtslevm`** and inspect its current function, dependencies and migration history. Rehearse the scoped migration in a disposable or staging environment.
2. Apply exactly **`supabase/migrations/20261020005345_independent_partner_scores.sql`** before releasing this frontend. Avoid a broad migration replay or unrelated pending migrations. Confirm the function replacement and authenticated-only execution grants.
3. Release the shared app used by both the Green Bay and Appleton domains. Both venue domains need the same compatible frontend and existing shared backend; no separate venue implementation is needed.
4. Verify with authorized player and staff accounts: one card now, the other later, both together, review/rejection, retries and closed-round refusal. Do not represent synthetic checks as live production verification.

## Validation and limits

- Local suite: **257 tests passed; 5 live integration tests skipped**. Production build passed with the existing bundle-size warning.
- Production migration verification confirmed all **16 existing score rows** and their checksum (`b1ef7b01bcbee3d321e35f5deb6c428a`) were unchanged. The subset gate, event lock and insert-only behavior were verified in the installed function; authenticated execution is allowed and anonymous execution is denied. Security advisory counts were unchanged from before the migration.
- Targeted component, draft and disposable PGlite function tests cover independent cards, later partner submission, roster-order remapping, preservation, retries, authorization and invalid payloads. They do not prove production RLS, grants, the complete live schema or real concurrent PostgREST requests.
- Synthetic browser checks exercised the first submission, the second partner later, both-card completion and refreshed authoritative totals. No live scores were submitted. The admin changes were reviewed from source; an authenticated admin browser walkthrough remains outstanding.
- Review concluded ship within the original narrow extension after two material fixes were resolved and rechecked. Backend deployment is verified; authenticated end-to-end production validation remains a separate check. No account mutation tests were performed.

## Recovery after release

Favor a forward fix while retaining all score data. Once partial teams exist, restoring the former frontend or all-partners submission gate can strand their remaining cards. Use the existing admin correction and closeout workflow as needed. **Never delete scores to roll back this feature.**
