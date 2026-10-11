# Commands

`/note <player_name> <note> <is_good>`
> Add a good or bad note about a player. The player can be identified by Steam name/ID or
> Discord name/ID. A user can add another note about the same player after 1 hour 30 minutes.
> If the player is not in the Nerf database, the bot shows close matches and asks whether to
> save the note anyway.

`/journal <player_name>`
> Look up a player's Steam and Discord identities, leaderboard stats/ranks, and notes.
> The player can be identified by Steam name/ID or Discord name/ID.

`/delete <player_name> <datetime>`
> Delete one of your notes about a player. Copy the timestamp shown in the journal, formatted
> as `DD/MM/YY HHh` (for example, `21/11/26 21h`).

## Nerf API (no cookie needed)

The database refreshes leaderboard data when a source is more than 12 hours old. Failed
leaderboard sources are retried on a later command; commands use the last successful snapshot
while a stale-data refresh runs.

- `api/leaderboards/kills/?type=all_time&limit=200000`
- `api/leaderboards/nesting/?type=all_time&limit=200000`
- `api/leaderboards/playtime?type=all_time&limit=200000`
- `api/leaderboards/meat?limit=200000`
- `api/leaderboards/bones?limit=200000`

Steam leaderboard rows are associated with Discord leaderboard identities using the Discord
user ID embedded in each row's avatar URL.
