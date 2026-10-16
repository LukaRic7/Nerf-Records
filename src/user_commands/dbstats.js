const {
    SlashCommandBuilder,
    InteractionContextType,
    EmbedBuilder
} = require('discord.js');
const { addDatabaseFooter } = require('../utils/database_footer.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dbstats')
        .setDescription('Show note statistics for the database.')
        .setContexts(
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const db = interaction.client.db;
        const stats = await db.getNoteStats();
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('Database note statistics')
            .addFields(
                {
                    name: 'Total notes',
                    value: Number(stats.total_note_count).toLocaleString('en-US'),
                    inline: true
                },
                {
                    name: 'Players with notes',
                    value: Number(stats.players_with_notes).toLocaleString('en-US'),
                    inline: true
                }
            );

        await interaction.editReply({
            embeds: [await addDatabaseFooter(embed, db)]
        });
    }
};
