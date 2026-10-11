const {
    Client,
    GatewayIntentBits,
    Collection,
    MessageFlags,
    EmbedBuilder,
    Partials,
    ChannelType
} = require('discord.js');
const fs = require('node:fs');
const path = require('path');
 
const CommandDeployer = require('./utils/deploy_commands.js');
const DatabaseManager = require('./utils/database.js');
const NerfApi = require('./utils/nerf_api.js');

const REFRESH_COMMAND_USER_ID = '1212173699281592360';

// Create the client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// Load commands into a collection
client.commands = new Collection();
for (const filePath of fs.readdirSync(path.join(__dirname, "user_commands"))) {
	const command = require(`./user_commands/${filePath}`);
	client.commands.set(command.data.name, command);
}

// Log when the client is ready
client.once('clientReady', async () => {
    const db = new DatabaseManager(path.join(__dirname, '../data/database.db'));
    await db.init();
    client.db = db;

    console.log(`Logged in as: "${client.user.tag}"`);
});

// Handle bot interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Log the entire slash command used
    const optionValues = interaction.options.data.map(option => option.value).join(' ');
    const username = interaction.user.username;
    const stringCommand = `/${interaction.commandName} ${optionValues}`;
    console.log(`[Commands] "${username}" => "${stringCommand}"`);

    // Grab the command data from the collection
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(`[Commands] /${interaction.commandName} failed:`, error);
        const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setDescription('The command could not be completed. Please try again later.');
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [embed], components: [] });
        } else {
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    }
});

client.on('messageCreate', async message => {
    if (
        message.author.id !== REFRESH_COMMAND_USER_ID
        || message.author.bot
        || message.channel.type !== ChannelType.DM
        || message.content.trim() !== '.refreshdb'
    ) {
        return;
    }

    try {
        if (!message.client.db) {
            throw new Error('Database is not initialized');
        }
        const result = await NerfApi.refreshDatabase(message.client.db);
        const embed = new EmbedBuilder()
            .setColor(result.failedSources.length ? 0xffa500 : 0x00ff00)
            .setTitle(result.failedSources.length
                ? 'Database refreshed with errors'
                : 'Database refreshed')
            .setDescription([
                `Updated: ${result.updatedSources.join(', ') || 'none'}`,
                `Players upserted: ${result.playerCount}`,
                ...(result.failedSources.length
                    ? [`Failed (will retry on a later command): ${result.failedSources.join(', ')}`]
                    : [])
            ].join('\n'));
        await message.reply({ embeds: [embed] });
    } catch (error) {
        console.error('[Commands] .refreshdb failed:', error);
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xff0000)
                    .setDescription('The database refresh failed. Check the bot logs for details.')
            ]
        });
    }
});

// Uncomment to deploy/unload global slash commands
CommandDeployer.deploySlashCommandsGlobally();

// Launch off!
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('Missing DISCORD_TOKEN environment variable.');
    process.exit(1);
}

client.login(token);