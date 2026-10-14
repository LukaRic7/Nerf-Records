const {
    SlashCommandBuilder,
    InteractionContextType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
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
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
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
        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('Player not found')
            .setDescription(
                `No Nerf player matched \`${identifier.replace(/[`<>]/g, '')}\`.\n\n`
                + (suggestions.length
                    ? 'Choose one of the closest matches below to view their journal.'
                    : 'No similar players were found.')
            );
        const components = suggestions.length
            ? [new ActionRowBuilder().addComponents(...suggestions.map((candidate, index) => {
                const label = `${candidate.steam_name} - ${candidate.steam_id}`;
                const truncatedLabel = `${candidate.steam_name.slice(
                    0,
                    Math.max(0, 74 - candidate.steam_id.length)
                )}... - ${candidate.steam_id}`;
                return new ButtonBuilder()
                    .setCustomId(`journal-player:${interaction.id}:${index}`)
                    .setLabel(label.length <= 80 ? label : truncatedLabel)
                    .setStyle(ButtonStyle.Primary);
            }))]
            : [];
        await interaction.editReply({
            embeds: [await addDatabaseFooter(embed, db)],
            components,
            flags: MessageFlags.Ephemeral
        });

        if (!suggestions.length) return;

        const message = await interaction.fetchReply();
        let selection;
        try {
            selection = await message.awaitMessageComponent({
                filter: component => component.user.id === interaction.user.id
                    && suggestions.some((_, index) =>
                        component.customId === `journal-player:${interaction.id}:${index}`
                    ),
                time: 60_000
            });
        } catch (error) {
            if (error.name !== 'InteractionCollectorError') throw error;
        }

        if (!selection) {
            await interaction.editReply({
                embeds: [
                    await addDatabaseFooter(
                        new EmbedBuilder()
                            .setColor(0xffa500)
                            .setDescription('Selection expired; no player was selected.'),
                        db
                    )
                ],
                components: [],
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const selectedIndex = Number(selection.customId.split(':').at(-1));
        const selectedPlayer = suggestions[selectedIndex];
        await selection.deferUpdate();
        await interaction.editReply({
            embeds: [await createJournalEmbed(db, selectedPlayer, selectedPlayer.steam_name)],
            components: []
        });
    }
};
