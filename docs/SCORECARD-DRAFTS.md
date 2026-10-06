# Unfinished scorecards

## Behavior

- Scores, optional hole stats, current hole, and stats-panel visibility save on the current browser/device after each committed edit.
- Returning to score entry restores the unfinished card after loading the current open event, course, roster, and submitted-score status.
- Drafts are keyed by account, location, league/session, event, and team. Fall drafts do not appear in winter. Scores are matched to player IDs even if the roster is returned in a different order.
- Changed course details or roster membership prevent incompatible restoration. The golfer sees a notice rather than applying old scores to a different setup.
- Successful submission clears the draft. Failed submission retains it. A server-side submission detected on return takes precedence over a local draft.
- Drafts do not affect standings or approvals. They are not sent to Supabase or shared with staff or teammates.
- If local storage is blocked/full, the screen explains that the draft cannot be saved. Clearing browser data removes local drafts. Private-browsing storage may disappear when that session closes.
- Recovery uses the same browser or installed app storage; it does not sync across devices or guarantee offline app startup. Round/roster verification still needs connectivity.

## Validation

- Added 17 unit cases for draft recovery, account/location/session/event/team separation, roster-order remapping, changed course/roster, malformed data, storage failures, clearing only the submitted round, and avoiding empty drafts.
- Browser checked with synthetic golfers and a mock database: score/stat entry, refresh recovery at the same hole, navigate away/return, failed submission followed by refresh, successful submission, and reopening a submitted round.
- No production data was used or changed. Existing database integration tests remain skipped; this change does not alter database functions or permissions.

## Scope decisions from Erich

Keep the existing shared default-password workflow. Appleton booking waits for his dedicated page URL. Fall and winter are the sessions; Monday–Thursday players belong to the same session and play the same courses.
