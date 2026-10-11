const {
    SlashCommandBuilder,
    InteractionContextType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
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
                components: []
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
        .setDescription('Add a good or bad note about a player.')
        .addStringOption(option => option
            .setName('player_name')
            .setDescription('Steam name/ID or Discord name/ID.')
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
            InteractionContextType.Guild,
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
        const suggestionText = suggestions.length
            ? suggestions.map(candidate =>
                `• **${candidate.steam_name}** - Steam ID: \`${candidate.steam_id}\``
            ).join('\n')
            : 'No similar players were found.';
        const warning = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('Player not found in the Nerf database')
            .setDescription(
                `The note you entered:\n> ${note.replace(/[\r\n]/g, ' ')}\n\n`
                + 'Would you still like to enter this note? You can also try one of these '
                + `players and copy their Steam ID:\n${suggestionText}`
            );
        const row = new ActionRowBuilder().addComponents(
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
            components: [row]
        });

        const message = await interaction.fetchReply();
        let confirmation;
        try {
            confirmation = await message.awaitMessageComponent({
                filter: component => component.user.id === interaction.user.id
                    && [`note-continue:${interaction.id}`, `note-abort:${interaction.id}`]
                        .includes(component.customId),
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
                components: []
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
                components: []
            });
            return;
        }

        await confirmation.deferUpdate();
        await addAndShowJournal(interaction, db, null, playerName, note, isGood);
    }
};
