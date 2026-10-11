const {
    SlashCommandBuilder,
    InteractionContextType,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');
const NerfApi = require('../utils/nerf_api.js');
const { addDatabaseFooter } = require('../utils/database_footer.js');

function parseJournalTimestamp(value) {
    const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2})h$/i);
    if (!match) {
        throw new Error('Use the journal timestamp format DD/MM/YY HHh, for example 21/11/26 21h.');
    }

    const [, day, month, year, hour] = match;
    const date = new Date(Date.UTC(2000 + Number(year), Number(month) - 1, Number(day), Number(hour)));
    if (
        date.getUTCFullYear() !== 2000 + Number(year)
        || date.getUTCMonth() !== Number(month) - 1
        || date.getUTCDate() !== Number(day)
        || date.getUTCHours() !== Number(hour)
    ) {
        throw new Error('That is not a valid journal timestamp.');
    }
    return date.toISOString();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('delete')
        .setDescription("Delete one of your notes from a player's journal.")
        .addStringOption(option => option
            .setName('player_name')
            .setDescription('Steam name/ID or Discord name/ID used for the player.')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100)
        )
        .addStringOption(option => option
            .setName('datetime')
            .setDescription('Timestamp shown beside the note, in DD/MM/YY HHh format.')
            .setRequired(true)
            .setMinLength(12)
            .setMaxLength(20)
        )
        .setContexts(
            InteractionContextType.BotDM
        ),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const db = interaction.client.db;
        await NerfApi.refreshIfStale(db);

        const playerName = interaction.options.getString('player_name', true).trim();
        let createdAt;
        try {
            createdAt = parseJournalTimestamp(
                interaction.options.getString('datetime', true)
            );
        } catch (error) {
            await interaction.editReply({
                embeds: [
                    await addDatabaseFooter(
                        new EmbedBuilder()
                            .setColor(0xffa500)
                            .setDescription(error.message),
                        db
                    )
                ], flags: MessageFlags.Ephemeral
            });
            return;
        }

        const player = await db.getPlayerByIdentifier(playerName);
        const deleted = await db.deleteNote({
            authorId: interaction.user.id,
            player,
            playerName,
            createdAt
        });
        await interaction.editReply({
            embeds: [
                await addDatabaseFooter(
                    new EmbedBuilder()
                        .setColor(deleted ? 0x00ff00 : 0xffa500)
                        .setDescription(deleted
                            ? 'Your note was deleted.'
                            : 'No note you wrote about that player was found at that timestamp.'),
                    db
                )
            ], flags: MessageFlags.Ephemeral
        });
    }
};
