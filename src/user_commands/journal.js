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

function formatPlayerButtonLabel(player) {
    const discordName = player.discord_name || player.discord_id || 'Unknown';
    const shortenedDiscordName = discordName.length > 26
        ? `${discordName.slice(0, 23)}...`
        : discordName;
    const prefix = `D: ${shortenedDiscordName} | S: `;
    const availableSteamNameLength = 80 - prefix.length;
    const steamName = player.steam_name.length > availableSteamNameLength
        ? `${player.steam_name.slice(0, availableSteamNameLength - 3)}...`
        : player.steam_name;
    return `${prefix}${steamName}`;
}

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
        const suggestionRows = suggestions.length
            ? [new ActionRowBuilder().addComponents(...suggestions.map((candidate, index) =>
                new ButtonBuilder()
                    .setCustomId(`journal-player:${interaction.id}:${index}`)
                    .setLabel(formatPlayerButtonLabel(candidate))
                    .setStyle(ButtonStyle.Primary)
            ))]
            : [];
        const abortRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`journal-abort:${interaction.id}`)
                .setLabel('Abort')
                .setStyle(ButtonStyle.Danger)
        );
        await interaction.editReply({
            embeds: [await addDatabaseFooter(embed, db)],
            components: [...suggestionRows, abortRow],
            flags: MessageFlags.Ephemeral
        });

        const message = await interaction.fetchReply();
        let selection;
        try {
            selection = await message.awaitMessageComponent({
                filter: component => component.user.id === interaction.user.id
                    && (
                        component.customId === `journal-abort:${interaction.id}`
                        || suggestions.some((_, index) =>
                            component.customId === `journal-player:${interaction.id}:${index}`
                        )
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

        if (selection.customId === `journal-abort:${interaction.id}`) {
            await selection.update({
                embeds: [
                    await addDatabaseFooter(
                        new EmbedBuilder()
                            .setColor(0x808080)
                            .setDescription('Player lookup cancelled.'),
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
