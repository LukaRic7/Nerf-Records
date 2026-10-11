const API_BASE_URL = 'https://api.nerfofficial.org/';
const LEADERBOARD_LIMIT = 300_000;
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

const SOURCES = [
    { key: 'kills', path: `api/leaderboards/kills/?type=all_time&limit=${LEADERBOARD_LIMIT}` },
    { key: 'nesting', path: `api/leaderboards/nesting/?type=all_time&limit=${LEADERBOARD_LIMIT}` },
    { key: 'playtime', path: `api/leaderboards/playtime?type=all_time&limit=${LEADERBOARD_LIMIT}` },
    { key: 'meat', path: `api/leaderboards/meat?limit=${LEADERBOARD_LIMIT}` },
    { key: 'bones', path: `api/leaderboards/bones?limit=${LEADERBOARD_LIMIT}` }
];

let refreshInProgress = null;

function getDiscordIdFromAvatar(avatarUrl) {
    if (typeof avatarUrl !== 'string') return null;
    return avatarUrl.match(/\/avatars\/(\d+)\//)?.[1] ?? null;
}

async function fetchLeaderboard(source) {
    console.log(`[Nerf API] Fetching ${source}`);
    const response = await fetch(new URL(source.path, API_BASE_URL), {
        signal: AbortSignal.timeout(600_000)
    });
    if (!response.ok) {
        throw new Error(`${source.key} leaderboard returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.success !== true || !Array.isArray(payload.leaderboard)) {
        throw new Error(`${source.key} leaderboard returned an invalid response`);
    }
    return payload.leaderboard;
}

function numericValue(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new Error(`Invalid ${label} value from Nerf API`);
    }
    return Math.round(number);
}

async function refreshLeaderboards(db, sources) {
    const results = await Promise.allSettled(sources.map(async source => ({
        source,
        rows: await fetchLeaderboard(source)
    })));
    const successful = [];
    const failedSources = [];
    for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'fulfilled') {
            successful.push(result.value);
        } else {
            failedSources.push(sources[index].key);
            console.error(`[Nerf API] Could not refresh ${sources[index].key}:`, result.reason);
        }
    }

    if (successful.length === 0) {
        await db.markLeaderboardSourcesStale(failedSources);
        throw new Error('No Nerf leaderboard endpoint could be refreshed');
    }

    const discordPlayers = new Map();
    for (const { source, rows } of successful) {
        if (source.key !== 'meat' && source.key !== 'bones') continue;
        for (const row of rows) {
            if (!row.discordId || !row.playerName) continue;
            const discordId = String(row.discordId);
            const player = discordPlayers.get(discordId) ?? {};
            player.discord_id = discordId;
            player.discord_name = row.playerName;
            player.discord_avatar_url = row.discordAvatar ?? player.discord_avatar_url ?? null;
            discordPlayers.set(discordId, player);
        }
    }

    const players = new Map();
    const leaderboard = new Map();
    const steamIdByDiscordId = new Map();

    for (const { source, rows } of successful) {
        for (const row of rows) {
            if (source.key === 'meat' || source.key === 'bones') continue;
            if (!row.steamId || !row.playerName) {
                throw new Error(`${source.key} leaderboard contains a row without Steam identity`);
            }

            const steamId = String(row.steamId);
            const avatarUrl = row.discordAvatar ?? null;
            const discordId = (row.discordId && String(row.discordId))
                || getDiscordIdFromAvatar(avatarUrl);
            const discord = discordId ? discordPlayers.get(discordId) : null;
            const player = players.get(steamId) ?? { steam_id: steamId };
            player.steam_name = row.playerName;
            player.discord_id = discordId ?? player.discord_id ?? null;
            player.discord_name = discord?.discord_name ?? player.discord_name ?? null;
            player.discord_avatar_url = avatarUrl ?? discord?.discord_avatar_url
                ?? player.discord_avatar_url ?? null;
            players.set(steamId, player);
            if (player.discord_id) steamIdByDiscordId.set(player.discord_id, steamId);

            const entry = leaderboard.get(steamId) ?? { steam_id: steamId };
            if (player.discord_id) entry.discord_id = player.discord_id;
            switch (source.key) {
                case 'kills':
                    entry.kills = numericValue(row.kills, 'kills');
                    entry.deaths = numericValue(row.deaths, 'deaths');
                    entry.favorite_dino = row.favoriteDino ?? null;
                    entry.kills_rank = numericValue(row.rank, 'kills rank');
                    break;
                case 'nesting':
                    entry.babies = numericValue(row.babies, 'babies');
                    entry.nest_points = numericValue(row.points, 'nest points');
                    entry.most_nested_dino = row.mostNestedDino ?? null;
                    entry.most_nested_count = numericValue(
                        row.mostNestedCount ?? 0, 'most nested count'
                    );
                    entry.nesting_rank = numericValue(row.rank, 'nesting rank');
                    break;
                case 'playtime':
                    entry.playtime_minutes = numericValue(row.totalMinutes, 'playtime');
                    entry.playtime_rank = numericValue(row.rank, 'playtime rank');
                    break;
            }
            leaderboard.set(steamId, entry);
        }
    }

    const unmatchedDiscordIds = [...discordPlayers.keys()]
        .filter(discordId => !steamIdByDiscordId.has(discordId));
    const existingPlayers = await db.getPlayersByDiscordIds(unmatchedDiscordIds);
    for (const player of existingPlayers) {
        players.set(player.steam_id, player);
        steamIdByDiscordId.set(player.discord_id, player.steam_id);
        leaderboard.set(player.steam_id, {
            steam_id: player.steam_id,
            discord_id: player.discord_id
        });
    }

    for (const { source, rows } of successful) {
        if (source.key !== 'meat' && source.key !== 'bones') continue;
        for (const row of rows) {
            const discordId = String(row.discordId ?? '');
            const steamId = steamIdByDiscordId.get(discordId);
            if (!steamId) continue;
            const entry = leaderboard.get(steamId);
            if (source.key === 'meat') {
                entry.meat = numericValue(row.meat, 'meat');
                entry.meat_rank = numericValue(row.rank, 'meat rank');
            } else {
                entry.bones = numericValue(row.bones, 'bones');
                entry.bones_rank = numericValue(row.rank, 'bones rank');
            }
        }
    }

    const updatedSources = successful.map(({ source }) => source.key);
    const playerRows = [...players.values()];
    const leaderboardRows = [...leaderboard.values()];
    await db.upsertLeaderboardSnapshot(playerRows, leaderboardRows, updatedSources);
    await db.markLeaderboardSourcesStale(failedSources);
    console.log(
        `[Nerf API] Refreshed ${updatedSources.join(', ')}; upserted ${playerRows.length} players.`
    );
    return { updatedSources, failedSources, playerCount: playerRows.length };
}

/**
 * Refresh stale API data. The first load is awaited so commands don't run against an empty DB;
 * subsequent stale refreshes run in the background while commands use the existing snapshot.
 */
async function refreshIfStale(db) {
    const metadata = await db.getMetadata();
    const staleSources = SOURCES.filter(source => {
        const updatedAt = metadata[`${source.key}_updated_at`];
        return !updatedAt || Date.now() - Date.parse(updatedAt) >= REFRESH_INTERVAL_MS;
    });
    if (staleSources.length === 0) return;
    if (refreshInProgress) {
        if (!metadata.leaderboard_updated_at) await refreshInProgress;
        return;
    }

    const refresh = refreshLeaderboards(db, SOURCES);
    refreshInProgress = refresh;
    if (!metadata.leaderboard_updated_at) {
        try {
            await refresh;
        } finally {
            refreshInProgress = null;
        }
        return;
    }

    refresh.catch(error => console.error('[Nerf API] Background refresh failed:', error))
        .finally(() => {
            refreshInProgress = null;
        });
}

async function refreshDatabase(db) {
    if (refreshInProgress) {
        try {
            await refreshInProgress;
        } catch (error) {
            console.error('[Nerf API] Refresh already in progress failed before manual retry:', error);
        }
    }

    const refresh = refreshLeaderboards(db, SOURCES);
    refreshInProgress = refresh;
    try {
        return await refresh;
    } finally {
        if (refreshInProgress === refresh) refreshInProgress = null;
    }
}

module.exports = {
    getDiscordIdFromAvatar,
    refreshIfStale,
    refreshDatabase
};
