function formatDatabaseAge(timestamp) {
    if (!timestamp) return 'not yet updated';
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) return 'unknown';

    const totalMinutes = Math.floor(Math.max(0, Date.now() - timestampMs) / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return `${days}d ${hours}h ${minutes}m`;
}

async function addDatabaseFooter(embed, db) {
    const metadata = await db.getMetadata();
    return embed.setFooter({
        text: `DB age: ${formatDatabaseAge(metadata.leaderboard_updated_at)} · `
            + `Players: ${Number(metadata.player_count ?? 0).toLocaleString('en-US')}`
    });
}

module.exports = { addDatabaseFooter, formatDatabaseAge };
