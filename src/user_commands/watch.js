const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    InteractionContextType
} = require('discord.js');
const NerfApi = require('../utils/nerf_api.js');

const DINOSAUR_LIMITS = new Map([
    ['Tyrannosaurus', 15],
    ['Deinosuchus', 25],
    ['Allosaurus', 25],
    ['Ceratosaurus', 38],
    ['Omniraptor', 40],
    ['Triceratops', 30]
]);
const MAX_FETCHES = 30;
const FETCH_INTERVAL_MS = 10_000;
const activeWatches = new Map();
let pollingLoopRunning = false;

function createWatchEmbed(watch) {
    const state = {
        WATCHING: { emoji: '\u{1F504}', color: 0x3498db },
        STOPPED: { emoji: '\u{23F9}', color: 0x808080 },
        AVAILABLE: { emoji: '\u{2705}', color: 0x2ecc71 }
    }[watch.status];
    const population = watch.population === null ? 'Unknown' : watch.population;

    return new EmbedBuilder()
        .setColor(state.color)
        .setTitle(`${state.emoji} ${watch.status}`)
        .setDescription([
            `**${watch.species}** population: **${population}**/${watch.limit}`,
            `Fetches performed: ${watch.fetches}/${MAX_FETCHES}`,
            ...(watch.detail ? [watch.detail] : [])
        ].join('\n'))
        .setFooter({ text: 'EU server' });
}

function createWatchComponents(watch) {
    if (watch.status !== 'WATCHING') return [];

    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`watch-stop:${watch.interaction.id}`)
            .setLabel('Stop watch')
            .setStyle(ButtonStyle.Danger)
    )];
}

function queueWatchUpdate(watch) {
    watch.updateQueue = watch.updateQueue.then(() => watch.interaction.editReply({
        embeds: [createWatchEmbed(watch)],
        components: createWatchComponents(watch)
    })).catch(error => {
        console.error(`[Watch] Could not update /watch ${watch.species}:`, error);
        if (watch.active) {
            watch.active = false;
            activeWatches.delete(watch.interaction.id);
        }
    });
    return watch.updateQueue;
}

async function stopWatch(watch, detail) {
    if (!watch.active) return;
    watch.active = false;
    watch.status = 'STOPPED';
    watch.detail = detail;
    activeWatches.delete(watch.interaction.id);
    await queueWatchUpdate(watch);
}

async function runPollingLoop() {
    while (activeWatches.size > 0) {
        const batch = [...activeWatches.values()];
        for (const watch of batch) watch.fetches++;

        let populations;
        let fetchError;
        try {
            populations = await NerfApi.fetchPopulationCounts();
        } catch (error) {
            fetchError = error;
            console.error('[Watch] Population fetch failed:', error);
        }

        for (const watch of batch) {
            if (!watch.active) continue;

            if (fetchError) {
                watch.detail = 'Population fetch failed; retrying on the next check.';
            } else {
                watch.population = populations.get(watch.species) ?? null;
                if (watch.population === null) {
                    watch.detail = 'No population data was returned for this dinosaur.';
                } else if (watch.population < watch.limit) {
                    watch.status = 'AVAILABLE';
                    watch.detail = 'Population is below the configured limit.';
                } else {
                    watch.detail = 'Waiting for the population to fall below the limit.';
                }
            }

            if (watch.status === 'WATCHING' && watch.fetches >= MAX_FETCHES) {
                watch.status = 'STOPPED';
                watch.detail = 'Stopped after 30 fetches; no opening was found.';
            }

            if (watch.status !== 'WATCHING') {
                watch.active = false;
                activeWatches.delete(watch.interaction.id);
                watch.collector?.stop('finished');
            }
            await queueWatchUpdate(watch);
        }

        if (activeWatches.size > 0) {
            await new Promise(resolve => setTimeout(resolve, FETCH_INTERVAL_MS));
        }
    }
}

function ensurePollingLoop() {
    if (pollingLoopRunning) return;
    pollingLoopRunning = true;
    runPollingLoop().catch(error => {
        console.error('[Watch] Polling loop failed:', error);
    }).finally(() => {
        pollingLoopRunning = false;
        if (activeWatches.size > 0) ensurePollingLoop();
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('watch')
        .setDescription('Watch for a dinosaur population opening on the EU server only.')
        .addStringOption(option => option
            .setName('dinosaur')
            .setDescription('Dinosaur to watch for an available population slot.')
            .setRequired(true)
            .addChoices(...[...DINOSAUR_LIMITS.keys()].map(species => ({
                name: species,
                value: species
            })))
        )
        .setContexts(
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ),

    async execute(interaction) {
        const species = interaction.options.getString('dinosaur', true);
        const watch = {
            interaction,
            species,
            limit: DINOSAUR_LIMITS.get(species),
            status: 'WATCHING',
            fetches: 0,
            population: null,
            detail: 'Checking population every 10 seconds.',
            active: true,
            updateQueue: Promise.resolve(),
            collector: null
        };

        await interaction.reply({
            embeds: [createWatchEmbed(watch)],
            components: createWatchComponents(watch)
        });

        activeWatches.set(interaction.id, watch);
        ensurePollingLoop();

        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            filter: component => component.user.id === interaction.user.id
                && component.customId === `watch-stop:${interaction.id}`,
            time: 15 * 60_000
        });
        watch.collector = collector;
        collector.on('collect', async component => {
            await component.deferUpdate();
            await stopWatch(watch, 'Watch stopped by you.');
            collector.stop('stopped');
        });
        collector.on('end', () => {
            if (watch.active) {
                void stopWatch(watch, 'Watch stopped because its button expired.');
            }
        });
    }
};