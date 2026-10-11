const {
    SlashCommandBuilder,
    InteractionContextType,
    EmbedBuilder
} = require('discord.js');
const NerfApi = require('../utils/nerf_api.js');
const { createJournalEmbed } = require('../utils/journal_embed.js');
const { addDatabaseFooter } = require('../utils/database_footer.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('journal')
        .setDescription('Look up a Nerf player and their notes.')
        .addStringOption(option => option
            .setName('player_name')
            .setDescription('Steam name, Steam ID, Discord name, or Discord ID.')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100)
        )
        .setContexts(
            InteractionContextType.BotDM
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const db = interaction.client.db;
        await NerfApi.refreshIfStale(db);

        const identifier = interaction.options.getString('player_name', true).trim();
        const player = await db.getPlayerByIdentifier(identifier);
        if (player) {
            await interaction.editReply({
                embeds: [await createJournalEmbed(db, player, identifier)]
            });
            return;
        }

        const previousNotes = await db.getNotesForPlayer(null, identifier);
        if (previousNotes.length > 0) {
            await interaction.editReply({
                embeds: [await createJournalEmbed(db, null, identifier)]
            });
            return;
        }

        const suggestions = await db.getPlayerSuggestions(identifier);
        const suggestionText = suggestions.length
            ? suggestions.map(candidate =>
                `• **${candidate.steam_name}** - Steam ID: \`${candidate.steam_id}\``
            ).join('\n')
            : 'No similar players were found.';
        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('Player not found')
            .setDescription(
                `No Nerf player matched \`${identifier.replace(/[`<>]/g, '')}\`.\n\n`
                + `Closest matches:\n${suggestionText}`
            );
        await interaction.editReply({
            embeds: [await addDatabaseFooter(embed, db)]
        });
    }
};
