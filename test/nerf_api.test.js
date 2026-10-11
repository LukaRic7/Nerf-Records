const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DatabaseManager = require('../src/utils/database.js');
const NerfApi = require('../src/utils/nerf_api.js');

test('refreshDatabase keeps the kills endpoint Steam name when other endpoints return a Discord name', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nerf-records-'));
    const originalFetch = global.fetch;
    const steamId = '76561198000000000';
    const discordId = '123456789012345678';
    const steamName = 'Actual Steam Name';
    const discordName = 'Actual Discord Name';
    const avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/avatar.png`;
    const database = new DatabaseManager(path.join(directory, 'database.db'));

    global.fetch = async input => {
        const url = new URL(input);
        let row;
        if (url.pathname.includes('/meat')) {
            row = { rank: 1, discordId, playerName: discordName, meat: 10, discordAvatar: avatarUrl };
        } else if (url.pathname.includes('/bones')) {
            row = { rank: 1, discordId, playerName: discordName, bones: 20, discordAvatar: avatarUrl };
        } else if (url.pathname.includes('/kills/')) {
            row = {
                rank: 1, steamId, playerName: steamName, kills: 30, deaths: 4,
                favoriteDino: 'Allosaurus', discordAvatar: avatarUrl
            };
        } else if (url.pathname.includes('/nesting/')) {
            row = {
                rank: 1, steamId, playerName: discordName, babies: 5, points: 6,
                mostNestedDino: 'Allosaurus', mostNestedCount: 2,
                discordAvatar: avatarUrl
            };
        } else if (url.pathname.includes('/playtime')) {
            row = {
                rank: 1, steamId, playerName: discordName, totalMinutes: 60,
                discordAvatar: avatarUrl
            };
        } else {
            throw new Error(`Unexpected leaderboard URL: ${url}`);
        }
        return {
            ok: true,
            json: async () => ({ success: true, leaderboard: [row] })
        };
    };

    try {
        await database.init();
        await database.savePlayer({
            steam_id: steamId,
            steam_name: discordName,
            discord_id: discordId,
            discord_name: discordName
        });

        await NerfApi.refreshDatabase(database);

        const player = await database.getPlayerByIdentifier(discordId);
        assert.equal(player.steam_id, steamId);
        assert.equal(player.steam_name, steamName);
        assert.equal(player.discord_name, discordName);
        assert.equal(player.discord_id, discordId);
    } finally {
        global.fetch = originalFetch;
        if (database.db) await database.db.close();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
