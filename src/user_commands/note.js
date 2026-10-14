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

async function addAndShowJournal(interaction, db, player, playerName, note, isGood) {
    try {
        await db.addNote({
            authorId: interaction.user.id,
            authorName: interaction.user.username,
            player,
            playerName,
            note,
            isGood
        });
    } catch (error) {
        if (error.code === 'NOTE_COOLDOWN') {
            await interaction.editReply({
                embeds: [
                    await addDatabaseFooter(
                        new EmbedBuilder()
                            .setColor(0xffa500)
                            .setDescription(error.message),
                        db
                    )
                ],
                components: [], flags: MessageFlags.Ephemeral
            });
            return;
        }
        throw error;
    }

    await interaction.editReply({
        embeds: [await createJournalEmbed(db, player, playerName)],
        components: []
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('note')
        .setDescription('Add a good or bad note about a player. Visible for all!')
        .addStringOption(option => option
            .setName('player_name')
            .setDescription('Steam name, Steam ID, Discord name, or Discord ID (also accepts aliases).')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100)
        )
        .addStringOption(option => option
            .setName('note')
            .setDescription("The message to add to this player's journal.")
            .setRequired(true)
            .setMinLength(5)
            .setMaxLength(80)
        )
        .addBooleanOption(option => option
            .setName('is_good')
            .setDescription('Whether this is a good note.')
            .setRequired(true)
        )
        .setContexts(
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const db = interaction.client.db;
        await NerfApi.refreshIfStale(db);

        const playerName = interaction.options.getString('player_name', true).trim();
        const note = interaction.options.getString('note', true);
        const isGood = interaction.options.getBoolean('is_good', true);
        const player = await db.getPlayerByIdentifier(playerName);
        if (player) {
            await addAndShowJournal(interaction, db, player, playerName, note, isGood);
            return;
        }

        const suggestions = await db.getPlayerSuggestions(playerName);
        const warning = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('Player not found in the Nerf database')
            .setDescription(
                `The note you entered:\n> ${note.replace(/[\r\n]/g, ' ')}\n\n`
                + (suggestions.length
                    ? 'Choose a suggested player to add the note to them, or enter it for '
                        + 'the unmatched name.'
                    : 'Would you still like to enter this note for the unmatched name?')
            );
        const suggestionRows = suggestions.length
            ? [new ActionRowBuilder().addComponents(...suggestions.map((candidate, index) => {
                const label = `${candidate.steam_name} - ${candidate.steam_id}`;
                const truncatedLabel = `${candidate.steam_name.slice(
                    0,
                    Math.max(0, 74 - candidate.steam_id.length)
                )}... - ${candidate.steam_id}`;
                return new ButtonBuilder()
                    .setCustomId(`note-player:${interaction.id}:${index}`)
                    .setLabel(label.length <= 80 ? label : truncatedLabel)
                    .setStyle(ButtonStyle.Primary);
            }))]
            : [];
        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`note-continue:${interaction.id}`)
                .setLabel('Yes, enter note')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`note-abort:${interaction.id}`)
                .setLabel('Abort')
                .setStyle(ButtonStyle.Danger)
        );
        await interaction.editReply({
            embeds: [await addDatabaseFooter(warning, db)],
            components: [...suggestionRows, actionRow],
            flags: MessageFlags.Ephemeral
        });

        const message = await interaction.fetchReply();
        let confirmation;
        try {
            confirmation = await message.awaitMessageComponent({
                filter: component => component.user.id === interaction.user.id
                    && (
                        [`note-continue:${interaction.id}`, `note-abort:${interaction.id}`]
                            .includes(component.customId)
                        || suggestions.some((_, index) =>
                            component.customId === `note-player:${interaction.id}:${index}`
                        )
                    ),
                time: 60_000
            });
        } catch (error) {
            if (error.name !== 'InteractionCollectorError') throw error;
        }

        if (!confirmation) {
            await interaction.editReply({
                embeds: [
                    await addDatabaseFooter(
                        new EmbedBuilder()
                            .setColor(0xffa500)
                            .setDescription('Confirmation expired; no note was added.'),
                        db
                    )
                ],
                components: [], flags: MessageFlags.Ephemeral
            });
            return;
        }
        if (confirmation.customId === `note-abort:${interaction.id}`) {
            await confirmation.update({
                embeds: [
                    await addDatabaseFooter(
                        new EmbedBuilder()
                            .setColor(0x808080)
                            .setDescription('Note cancelled.'),
                        db
                    )
                ],
                components: [], flags: MessageFlags.Ephemeral
            });
            return;
        }

        await confirmation.deferUpdate();
        if (confirmation.customId.startsWith(`note-player:${interaction.id}:`)) {
            const selectedIndex = Number(confirmation.customId.split(':').at(-1));
            const selectedPlayer = suggestions[selectedIndex];
            await addAndShowJournal(
                interaction,
                db,
                selectedPlayer,
                selectedPlayer.steam_name,
                note,
                isGood
            );
            return;
        }
        await addAndShowJournal(interaction, db, null, playerName, note, isGood);
    }
};
