const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('path');
 
const CommandDeployer = require('./utils/deploy_commands.js');
const DatabaseManager = require('./utils/database.js');


// Create the client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
        const content = 'The command could not be completed. Please try again later.';
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content, embeds: [], components: [] });
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
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