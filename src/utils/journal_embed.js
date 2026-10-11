const { EmbedBuilder } = require('discord.js');
const { addDatabaseFooter } = require('./database_footer.js');

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${timestamp}`);
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/`
        + `${String(date.getUTCFullYear()).slice(-2)} ${pad(date.getUTCHours())}h`;
}

function cleanInline(value) {
    return String(value ?? '').replace(/[\r\n`<>]/g, ' ').trim();
}

function formatNumber(value) {
    return Number(value ?? 0).toLocaleString('en-US');
}

function rankValue(rank, value, suffix) {
    if (rank === null || rank === undefined) return '**#-** → Not ranked';
    return `**#${formatNumber(rank)}** → ${formatNumber(value)} ${suffix}`;
}

async function createJournalEmbed(db, player, identifier) {
    const displayName = player?.steam_name ?? identifier;
    const [leaderboard, notes] = await Promise.all([
        player ? db.getLeaderboardEntry(player.steam_id) : null,
        db.getNotesForPlayer(player, displayName)
    ]);

    const noteLines = notes.map(note => {
        const sentiment = note.is_good ? '+' : '-';
        const author = cleanInline(note.author_name || note.from_discord_id);
        const text = cleanInline(note.note);
        return `${sentiment} [${formatTimestamp(note.created_at)}] <${author}> ${text}`;
    });
    if (noteLines.length === 0) noteLines.push('(No notes yet)');

    const maxNotesLength = 3500;
    let displayedLines = [...noteLines];
    let notesText = displayedLines.join('\n');
    while (notesText.length > maxNotesLength && displayedLines.length > 1) {
        displayedLines.pop();
        notesText = displayedLines.join('\n');
    }
    const omittedCount = Math.max(0, notes.length - displayedLines.length);
    if (omittedCount > 0) {
        notesText += `\n... ${omittedCount} older notes omitted`;
    }

    const discordId = player?.discord_id ?? 'N/A';
    const noteCountText = omittedCount > 0
        ? ` · showing ${displayedLines.length} of ${notes.length} notes`
        : '';
    const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setAuthor({
            name: `${displayName}${player?.discord_name ? ` / ${player.discord_name}` : ''}`,
            ...(player?.discord_avatar_url ? { iconURL: player.discord_avatar_url } : {})
        })
        .setDescription(
            `-# SID: ${player?.steam_id ?? 'N/A'} / DID: ${discordId}${noteCountText}\n`
            + `\`\`\`diff\n${notesText}\n\`\`\``
        )
        .setTimestamp(new Date())
        .addFields(
            {
                name: '🔪  Kills',
                value: rankValue(leaderboard?.kills_rank, leaderboard?.kills, 'Kills'),
                inline: true
            },
            {
                name: '🪹  Nests',
                value: rankValue(leaderboard?.nesting_rank, leaderboard?.babies, 'Babies'),
                inline: true
            },
            {
                name: '⏱️ Playtime',
                value: rankValue(
                    leaderboard?.playtime_rank,
                    leaderboard ? Math.floor(leaderboard.playtime_minutes / 60) : 0,
                    'Hours'
                ),
                inline: true
            },
            {
                name: '🥩 Meat',
                value: rankValue(leaderboard?.meat_rank, leaderboard?.meat, 'Meat'),
                inline: true
            },
            {
                name: '🦴 Bones',
                value: rankValue(leaderboard?.bones_rank, leaderboard?.bones, 'Bones'),
                inline: true
            }
        );

    if (!player) {
        embed.setColor(0xffa500)
            .setTitle('Player not found in the Nerf database');
    }
    return addDatabaseFooter(embed, db);
}

module.exports = { createJournalEmbed, formatTimestamp };
