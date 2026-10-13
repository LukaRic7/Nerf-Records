const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Manager class for communicating with the database.
 */
class DatabaseManager {
    /**
     * Create a new DatabaseManager instance.
     * @param {string} dbFilePath - Path to the SQLite database file.
     */
    constructor(dbFilePath) {
        this.dbFilePath = dbFilePath;
        this.db = null;
    }

    /**
     * Initialize the database by opening a connection and enabling foreign keys.
     * @returns {Promise<void>}
     */
    async init() {
        await fs.mkdir(path.dirname(this.dbFilePath), { recursive: true });
        this.db = await open({ filename: this.dbFilePath, driver: sqlite3.Database });

        await this.db.exec('PRAGMA foreign_keys = ON;');
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                player_count INTEGER NOT NULL DEFAULT 0
                    CHECK (player_count >= 0),
                leaderboard_updated_at TEXT,
                kills_updated_at TEXT,
                nesting_updated_at TEXT,
                playtime_updated_at TEXT,
                meat_updated_at TEXT,
                bones_updated_at TEXT
            );
            
            INSERT OR IGNORE INTO metadata (
                id, player_count, leaderboard_updated_at
            ) VALUES (1, 0, NULL);
             
            CREATE TABLE IF NOT EXISTS players (
                steam_id TEXT PRIMARY KEY NOT NULL,
                steam_name TEXT NOT NULL,
                discord_id TEXT UNIQUE,
                discord_name TEXT,
                discord_avatar_url TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_players_steam_name
                ON players(steam_name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_players_discord_name
                ON players(discord_name COLLATE NOCASE);

            CREATE TABLE IF NOT EXISTS users (
                discord_id TEXT PRIMARY KEY NOT NULL,
                discord_name TEXT,
                last_message_at TEXT
            );

            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_discord_id TEXT NOT NULL,
                to_steam_id TEXT,
                to_steam_name TEXT NOT NULL,
                note TEXT NOT NULL,
                is_good INTEGER NOT NULL
                    CHECK (is_good IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT (
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ),

                FOREIGN KEY (from_discord_id)
                    REFERENCES users(discord_id)
                    ON UPDATE CASCADE
                    ON DELETE CASCADE,

                FOREIGN KEY (to_steam_id)
                    REFERENCES players(steam_id)
                    ON UPDATE CASCADE
                    ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_notes_author_player_created
                ON notes(
                    from_discord_id,
                    to_steam_name COLLATE NOCASE,
                    created_at DESC
                );

            CREATE INDEX IF NOT EXISTS idx_notes_player_created
                ON notes(to_steam_id, created_at DESC);
            
            CREATE TABLE IF NOT EXISTS leaderboard (
                steam_id TEXT PRIMARY KEY NOT NULL,
                discord_id TEXT,
                bones INTEGER NOT NULL DEFAULT 0
                    CHECK (bones >= 0),
                meat INTEGER NOT NULL DEFAULT 0
                    CHECK (meat >= 0),
                kills INTEGER NOT NULL DEFAULT 0
                    CHECK (kills >= 0),
                deaths INTEGER NOT NULL DEFAULT 0
                    CHECK (deaths >= 0),
                favorite_dino TEXT,
                babies INTEGER NOT NULL DEFAULT 0
                    CHECK (babies >= 0),
                nest_points INTEGER NOT NULL DEFAULT 0
                    CHECK (nest_points >= 0),
                most_nested_dino TEXT,
                most_nested_count INTEGER NOT NULL DEFAULT 0
                    CHECK (most_nested_count >= 0),
                playtime_minutes INTEGER NOT NULL DEFAULT 0
                    CHECK (playtime_minutes >= 0),
                kills_rank INTEGER,
                nesting_rank INTEGER,
                playtime_rank INTEGER,
                meat_rank INTEGER,
                bones_rank INTEGER,
                
                FOREIGN KEY (steam_id)
                    REFERENCES players(steam_id)
                    ON UPDATE CASCADE
                    ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_leaderboard_bones
                ON leaderboard(bones DESC);
            
            CREATE INDEX IF NOT EXISTS idx_leaderboard_kills
                ON leaderboard(kills DESC);
            
            CREATE INDEX IF NOT EXISTS idx_leaderboard_playtime
                ON leaderboard(playtime_minutes DESC);
            
            DROP TRIGGER IF EXISTS players_after_insert;
            CREATE TRIGGER players_after_insert
            AFTER INSERT ON players
            BEGIN
                UPDATE metadata
                SET player_count = player_count + 1
                WHERE id = 1;
            END;
            
            DROP TRIGGER IF EXISTS players_after_delete;
            CREATE TRIGGER players_after_delete
            AFTER DELETE ON players
            BEGIN
                UPDATE metadata
                SET player_count = MAX(player_count - 1, 0)
                WHERE id = 1;
            END;
            
            DROP TRIGGER IF EXISTS players_after_discord_update;
            CREATE TRIGGER players_after_discord_update
            AFTER UPDATE OF discord_id ON players
            WHEN OLD.discord_id IS NOT NEW.discord_id
            BEGIN
                UPDATE leaderboard
                SET discord_id = NEW.discord_id
                WHERE steam_id = NEW.steam_id;
            END;
        `);

        const userColumns = await this.db.all('PRAGMA table_info(users)');
        if (!userColumns.some(column => column.name === 'discord_name')) {
            await this.db.exec('ALTER TABLE users ADD COLUMN discord_name TEXT');
        }
        if (userColumns.find(column => column.name === 'discord_id')?.pk !== 1) {
            await this.db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_id
                    ON users(discord_id)
            `);
        }

        const leaderboardColumns = await this.db.all('PRAGMA table_info(leaderboard)');
        for (const column of [
            'kills_rank', 'nesting_rank', 'playtime_rank', 'meat_rank', 'bones_rank'
        ]) {
            if (!leaderboardColumns.some(existing => existing.name === column)) {
                await this.db.exec(`ALTER TABLE leaderboard ADD COLUMN ${column} INTEGER`);
            }
        }
        const metadataColumns = await this.db.all('PRAGMA table_info(metadata)');
        for (const column of [
            'kills_updated_at', 'nesting_updated_at', 'playtime_updated_at',
            'meat_updated_at', 'bones_updated_at'
        ]) {
            if (!metadataColumns.some(existing => existing.name === column)) {
                await this.db.exec(`ALTER TABLE metadata ADD COLUMN ${column} TEXT`);
            }
        }
        
        // Correct the count in case the database already contained players.
        await this.db.run(`
            UPDATE metadata
            SET player_count = (SELECT COUNT(*) FROM players)
            WHERE id = 1
        `);

        console.log(`Database connected at: "${this.dbFilePath}"`);
    }

    /**
     * Insert or update a player.
     * Missing fields remain unchanged; explicit null clears nullable fields.
     */
    async savePlayer(data = {}) {
        const { steam_id, ...fields } = data;

        if (!steam_id) {
            throw new Error('steam_id is required');
        }

        const allowed = ['steam_name', 'discord_id', 'discord_name', 'discord_avatar_url'];
        const existing = await this.db.get('SELECT * FROM players WHERE steam_id = ?', [steam_id]);

        if (!existing) {
            if (!fields.steam_name) {
                throw new Error('steam_name is required for a new player');
            }

            await this.db.run(`
                INSERT INTO players (
                    steam_id, steam_name, discord_id, discord_name, discord_avatar_url
                ) VALUES (?, ?, ?, ?, ?)
            `, [
                steam_id, fields.steam_name, fields.discord_id ?? null, fields.discord_name ?? null,
                fields.discord_avatar_url ?? null
            ]);

            return;
        }

        const updates = allowed.filter(key => Object.prototype.hasOwnProperty.call(fields, key));
        if (updates.length === 0) return;

        const setClause = updates.map(key => `"${key}" = ?`).join(', ');

        await this.db.run(
            `UPDATE players SET ${setClause} WHERE steam_id = ?`,
            [...updates.map(key => fields[key]), steam_id]
        );
    }

    /**
     * Insert or update leaderboard statistics.
     */
    async saveLeaderboard(data = {}) {
        const { steam_id, ...fields } = data;

        if (!steam_id) {
            throw new Error('steam_id is required');
        }

        const allowed = [
            'discord_id', 'bones', 'meat', 'kills', 'deaths', 'favorite_dino', 'babies',
            'nest_points', 'most_nested_dino', 'most_nested_count', 'playtime_minutes',
            'kills_rank', 'nesting_rank', 'playtime_rank', 'meat_rank', 'bones_rank'
        ];

        const supplied = allowed.filter(key => Object.prototype.hasOwnProperty.call(fields, key));

        const existing = await this.db.get(
            'SELECT steam_id FROM leaderboard WHERE steam_id = ?',
            [steam_id]
        );

        if (!existing) {
            const player = await this.db.get(
                'SELECT steam_id, discord_id FROM players WHERE steam_id = ?',
                [steam_id]
            );

            if (!player) {
                throw new Error(`Player ${steam_id} does not exist`);
            }

            const columns = ['steam_id', ...supplied];
            const values = [steam_id, ...supplied.map(key => fields[key])];

            if (!Object.prototype.hasOwnProperty.call(fields, 'discord_id')) {
                columns.push('discord_id');
                values.push(player.discord_id ?? null);
            }

            const placeholders = columns.map(() => '?').join(', ');

            await this.db.run(`
                INSERT INTO leaderboard (${columns.join(', ')}) VALUES (${placeholders})`,
                values
            );
        } else if (supplied.length > 0) {
            const setClause = supplied.map(key => `"${key}" = ?`).join(', ');

            await this.db.run(
                `UPDATE leaderboard SET ${setClause} WHERE steam_id = ?`,
                [...supplied.map(key => fields[key]), steam_id]
            );
        }

        await this.updateLeaderboardTimestamp();
    }
    
    /**
     * Insert multiple notes in one transaction.
     *
     * Each item:
     * {
     *   discord_id: string,
     *   steam_name: string,
     *   note: string,
     *   is_good: boolean,
     *   created_at?: string,
     *   last_message_at?: string | null
     * }
     *
     * @returns {Promise<{ inserted: number }>}
     */
    async bulkInsertNotes(notes = []) {
        if (!Array.isArray(notes)) {
            throw new Error('notes must be an array');
        }

        if (notes.length === 0) {
            return { inserted: 0 };
        }

        await this.db.exec('BEGIN IMMEDIATE');

        try {
            for (const item of notes) {
                if (!item || !item.discord_id) {
                    throw new Error('Each note requires discord_id');
                }

                if (typeof item.steam_name !== 'string' || !item.steam_name.trim()) {
                    throw new Error('Each note requires a steam_name');
                }

                if (typeof item.note !== 'string' || !item.note.trim()) {
                    throw new Error('Each note requires non-empty note text');
                }

                if (typeof item.is_good !== 'boolean' && item.is_good !== 0 && item.is_good !== 1) {
                    throw new Error('is_good must be a boolean or 0/1');
                }

                const discordId = String(item.discord_id);
                const steamName = item.steam_name.trim();
                const createdAt = item.created_at ?? new Date().toISOString();

                // Automatically register the author if needed.
                // Keep the newest last_message_at timestamp.
                await this.db.run(`
                    INSERT INTO users (discord_id, last_message_at) VALUES (?, ?)
                    ON CONFLICT(discord_id) DO UPDATE SET
                        last_message_at = CASE
                            WHEN excluded.last_message_at IS NULL
                                THEN users.last_message_at
                            WHEN users.last_message_at IS NULL
                                OR excluded.last_message_at >
                                   users.last_message_at
                                THEN excluded.last_message_at
                            ELSE users.last_message_at
                        END
                `, [
                    discordId,
                    item.last_message_at === undefined ? createdAt : item.last_message_at
                ]);

                // A matching registered player gets a foreign key.
                // Otherwise the typed Steam name is still stored.
                const player = await this.db.get(`
                    SELECT steam_id
                    FROM players
                    WHERE steam_name = ? COLLATE NOCASE
                    ORDER BY steam_id
                    LIMIT 1
                `, [steamName]);

                await this.db.run(`
                    INSERT INTO notes (
                        from_discord_id, to_steam_id, to_steam_name, note, is_good, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    discordId, player?.steam_id ?? null, steamName, item.note.trim(),
                    item.is_good === true || item.is_good === 1 ? 1 : 0, createdAt
                ]);
            }

            await this.db.exec('COMMIT');

            return { inserted: notes.length };
        } catch (error) {
            await this.db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Create or update a user.
     */
    async saveUser(discordId, lastMessageAt = new Date().toISOString()) {
        if (!discordId) {
            throw new Error('discordId is required');
        }

        await this.db.run(`
            INSERT INTO users (discord_id, last_message_at)
            VALUES (?, ?)
            ON CONFLICT(discord_id) DO UPDATE SET
                last_message_at = excluded.last_message_at
        `, [String(discordId), lastMessageAt]);
    }

    /**
     * Upsert API player identities and leaderboard values together in one transaction.
     */
    async upsertLeaderboardSnapshot(players, entries, updatedSources = []) {
        if (!Array.isArray(players) || !Array.isArray(entries)) {
            throw new Error('players and entries must be arrays');
        }

        await this.db.exec('BEGIN IMMEDIATE');
        try {
            const skippedLeaderboardSteamIds = new Set();
            const playerStatement = await this.db.prepare(`
                INSERT INTO players (
                    steam_id, steam_name, discord_id, discord_name, discord_avatar_url
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(steam_id) DO UPDATE SET
                    steam_name = excluded.steam_name,
                    discord_id = COALESCE(excluded.discord_id, players.discord_id),
                    discord_name = COALESCE(excluded.discord_name, players.discord_name),
                    discord_avatar_url = COALESCE(
                        excluded.discord_avatar_url, players.discord_avatar_url
                    )
            `);
            try {
                for (const player of players) {
                    if (!player.steam_id || !player.steam_name) {
                        throw new Error('Each player requires steam_id and steam_name');
                    }
                    try {
                        await playerStatement.run(
                            String(player.steam_id), player.steam_name,
                            player.discord_id ?? null, player.discord_name ?? null,
                            player.discord_avatar_url ?? null
                        );
                    } catch (error) {
                        if (error.code !== 'SQLITE_CONSTRAINT' ||
                            !error.message.includes('UNIQUE constraint failed: players.discord_id')) {
                            throw error;
                        }
                        const existingPlayer = await this.db.get(
                            'SELECT steam_id FROM players WHERE steam_id = ?',
                            [String(player.steam_id)]
                        );
                        if (!existingPlayer) {
                            skippedLeaderboardSteamIds.add(String(player.steam_id));
                        }
                        console.warn(
                            `[Nerf API] Skipping player ${player.steam_id}` +
                            `${existingPlayer ? '' : ' and its leaderboard rows'}: Discord ID ` +
                            `${player.discord_id} is already linked to another player.`
                        );
                    }
                }
            } finally {
                await playerStatement.finalize();
            }

            const statements = new Map();
            try {
                for (const entry of entries) {
                    if (!entry.steam_id) {
                        throw new Error('Each leaderboard entry requires steam_id');
                    }
                    if (skippedLeaderboardSteamIds.has(String(entry.steam_id))) continue;

                    const fields = Object.keys(entry).filter(key => key !== 'steam_id');
                    if (fields.length === 0) continue;
                    const columns = ['steam_id', ...fields];
                    const key = columns.join(',');
                    let statement = statements.get(key);
                    if (!statement) {
                        const updates = fields.map(column =>
                            `"${column}" = excluded."${column}"`
                        ).join(', ');
                        statement = await this.db.prepare(`
                            INSERT INTO leaderboard (${columns.map(column => `"${column}"`).join(', ')})
                            VALUES (${columns.map(() => '?').join(', ')})
                            ON CONFLICT(steam_id) DO UPDATE SET ${updates}
                        `);
                        statements.set(key, statement);
                    }

                    await statement.run([entry.steam_id, ...fields.map(field => entry[field])]);
                }
            } finally {
                for (const statement of statements.values()) {
                    await statement.finalize();
                }
            }

            await this.updateLeaderboardTimestamp(updatedSources);
            await this.db.exec('COMMIT');
        } catch (error) {
            await this.db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Resolve a Steam/Discord ID or name to a known player.
     */
    async getPlayerByIdentifier(identifier) {
        if (typeof identifier !== 'string' || !identifier.trim()) {
            throw new Error('player identifier is required');
        }
        const value = identifier.trim();
        return this.db.get(`
            SELECT *
            FROM players
            WHERE steam_id = ? OR discord_id = ?
                OR steam_name = ? COLLATE NOCASE
                OR discord_name = ? COLLATE NOCASE
            ORDER BY CASE
                WHEN steam_id = ? OR discord_id = ? THEN 0
                WHEN steam_name = ? COLLATE NOCASE THEN 1
                ELSE 2
            END
            LIMIT 1
        `, [value, value, value, value, value, value, value]);
    }

    async getPlayersByDiscordIds(discordIds) {
        if (!Array.isArray(discordIds)) {
            throw new Error('discordIds must be an array');
        }
        const players = [];
        for (let index = 0; index < discordIds.length; index += 500) {
            const batch = [...new Set(discordIds.slice(index, index + 500).map(String))];
            if (batch.length === 0) continue;
            players.push(...await this.db.all(`
                SELECT *
                FROM players
                WHERE discord_id IN (${batch.map(() => '?').join(', ')})
            `, batch));
        }
        return players;
    }

    /**
     * Return the closest known players for a misspelled name or ID.
     */
    async getPlayerSuggestions(identifier, limit = 5) {
        const query = String(identifier).trim().toLocaleLowerCase();
        if (!query) return [];

        const rows = await this.db.all(`
            SELECT steam_id, steam_name, discord_id, discord_name
            FROM players
        `);

        const distance = (left, right) => {
            if (Math.abs(left.length - right.length) > 8) return 9;
            let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
            for (let i = 1; i <= left.length; i++) {
                const current = [i];
                for (let j = 1; j <= right.length; j++) {
                    current[j] = Math.min(
                        current[j - 1] + 1,
                        previous[j] + 1,
                        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
                    );
                }
                previous = current;
            }
            return previous[right.length];
        };

        return rows.map(player => {
            const values = [player.steam_name, player.discord_name, player.steam_id, player.discord_id]
                .filter(Boolean)
                .map(value => String(value).toLocaleLowerCase());
            return {
                ...player,
                score: Math.min(...values.map(value => distance(query, value)))
            };
        }).sort((left, right) =>
            left.score - right.score || left.steam_name.localeCompare(right.steam_name)
        ).slice(0, Math.max(0, Math.min(5, limit)));
    }

    /**
     * Insert a note, linking it to a known player when one was resolved.
     */
    async addNote({ authorId, authorName, player, playerName, note, isGood }) {
        if (!authorId) throw new Error('authorId is required');
        if (typeof note !== 'string' || !note.trim()) throw new Error('note is required');
        if (typeof isGood !== 'boolean') throw new Error('isGood must be a boolean');
        const typedPlayerName = playerName?.trim();
        const storedPlayerName = player?.steam_name ?? typedPlayerName;
        if (!storedPlayerName) throw new Error('playerName is required');

        const createdAt = new Date().toISOString();
        await this.db.exec('BEGIN IMMEDIATE');
        try {
            const latest = await this.db.get(`
                SELECT created_at
                FROM notes
                WHERE from_discord_id = ?
                    AND (
                        (? IS NOT NULL AND to_steam_id = ?)
                        OR (to_steam_id IS NULL AND to_steam_name COLLATE NOCASE
                            IN (?, ?, ?, ?, ?))
                    )
                ORDER BY created_at DESC, id DESC
                LIMIT 1
            `, [
                String(authorId), player?.steam_id ?? null, player?.steam_id ?? null,
                player?.steam_name ?? typedPlayerName ?? storedPlayerName,
                player?.steam_id ?? typedPlayerName ?? storedPlayerName,
                player?.discord_id ?? typedPlayerName ?? storedPlayerName,
                player?.discord_name ?? typedPlayerName ?? storedPlayerName,
                typedPlayerName ?? storedPlayerName
            ]);
            if (latest) {
                const elapsed = Date.now() - Date.parse(latest.created_at);
                if (!Number.isFinite(elapsed)) {
                    throw new Error(`Invalid created_at timestamp: ${latest.created_at}`);
                }
                if (elapsed < 90 * 60 * 1000) {
                    const error = new Error('You can add another note about this player in '
                        + `${Math.ceil((90 * 60 * 1000 - elapsed) / 60_000)} minutes.`);
                    error.code = 'NOTE_COOLDOWN';
                    throw error;
                }
            }

            await this.db.run(`
                INSERT INTO users (discord_id, discord_name, last_message_at)
                VALUES (?, ?, ?)
                ON CONFLICT(discord_id) DO UPDATE SET
                    discord_name = COALESCE(excluded.discord_name, users.discord_name),
                    last_message_at = excluded.last_message_at
            `, [String(authorId), authorName ?? null, createdAt]);
            const result = await this.db.run(`
                INSERT INTO notes (
                    from_discord_id, to_steam_id, to_steam_name, note, is_good, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
            `, [
                String(authorId), player?.steam_id ?? null, storedPlayerName,
                note.trim(), isGood ? 1 : 0, createdAt
            ]);
            await this.db.exec('COMMIT');
            return { id: result.lastID, created_at: createdAt };
        } catch (error) {
            await this.db.exec('ROLLBACK');
            throw error;
        }
    }

    async getNotesForPlayer(player, playerName = null) {
        const name = player?.steam_name ?? playerName;
        if (!name) throw new Error('player name is required');
        if (player?.steam_id) {
            const aliases = [...new Set([
                player.steam_name, player.steam_id, player.discord_name, player.discord_id,
                playerName
            ].filter(Boolean))];
            return this.db.all(`
                SELECT n.*, u.discord_name AS author_name
                FROM notes n
                LEFT JOIN users u ON u.discord_id = n.from_discord_id
                WHERE n.to_steam_id = ?
                    OR (n.to_steam_id IS NULL AND n.to_steam_name COLLATE NOCASE IN (
                        ${aliases.map(() => '?').join(', ')}
                    ))
                ORDER BY n.created_at DESC, n.id DESC
            `, [player.steam_id, ...aliases]);
        }
        return this.db.all(`
            SELECT n.*, u.discord_name AS author_name
            FROM notes n
            LEFT JOIN users u ON u.discord_id = n.from_discord_id
            WHERE n.to_steam_id IS NULL AND n.to_steam_name = ? COLLATE NOCASE
            ORDER BY n.created_at DESC, n.id DESC
        `, [name]);
    }

    async deleteNote({ authorId, player, playerName, createdAt }) {
        if (!authorId) throw new Error('authorId is required');
        const name = playerName?.trim() ?? player?.steam_name;
        if (!name) throw new Error('playerName is required');
        const aliases = [...new Set([
            player?.steam_name, player?.steam_id, player?.discord_name, player?.discord_id, name
        ].filter(Boolean))];
        const rows = await this.db.all(`
            SELECT id
            FROM notes
            WHERE from_discord_id = ?
                AND created_at >= ? AND created_at < ?
                AND (
                    (? IS NOT NULL AND to_steam_id = ?)
                    OR (to_steam_id IS NULL AND to_steam_name COLLATE NOCASE IN (
                        ${aliases.map(() => '?').join(', ')}
                    ))
                )
            ORDER BY id
        `, [
            String(authorId), createdAt, new Date(Date.parse(createdAt) + 60 * 60 * 1000).toISOString(),
            player?.steam_id ?? null, player?.steam_id ?? null, ...aliases
        ]);
        if (rows.length > 1) {
            throw new Error('More than one note matches that time; no note was deleted.');
        }
        if (rows.length === 0) return false;
        await this.db.run('DELETE FROM notes WHERE id = ?', [rows[0].id]);
        return true;
    }

    /**
     * Get a player by Steam ID.
     *
     * @param {string} steam_id
     * @returns {Promise<Object|undefined>}
     */
    async getPlayer(steam_id) {
        if (!steam_id) throw new Error('steam_id is required');
    
        return this.db.get('SELECT * FROM players WHERE steam_id = ?', [steam_id]);
    }
    
    /**
     * Get a leaderboard entry by Steam ID.
     *
     * @param {string} steam_id
     * @returns {Promise<Object|undefined>}
     */
    async getLeaderboardEntry(steam_id) {
        if (!steam_id) throw new Error('steam_id is required');
    
        return this.db.get(`
            SELECT p.steam_name, p.discord_name, l.*
            FROM leaderboard l
            JOIN players p ON p.steam_id = l.steam_id
            WHERE l.steam_id = ?`,
            [steam_id]
        );
    }
    
    /**
     * Get rows from either table with optional filters. Every filter is matched using equality.
     *
     * @param {'players'|'leaderboard'} table
     * @param {Object} filters
     * @returns {Promise<Array<Object>>}
     */
    async find(table, filters = {}) {
        const allowedColumns = {
            players: [
                'steam_id', 'steam_name', 'discord_id', 'discord_name', 'discord_avatar_url'
            ],
            leaderboard: [
                'steam_id', 'discord_id', 'bones', 'meat', 'kills', 'deaths', 'favorite_dino',
                'babies', 'nest_points', 'most_nested_dino', 'most_nested_count',
                'playtime_minutes', 'kills_rank', 'nesting_rank', 'playtime_rank', 'meat_rank',
                'bones_rank',
            ]
        };
    
        if (!allowedColumns[table]) {
            throw new Error('Invalid table');
        }
    
        const keys = Object.keys(filters);
    
        for (const key of keys) {
            if (!allowedColumns[table].includes(key)) {
                throw new Error(`Invalid column: ${key}`);
            }
        }
    
        let sql = `SELECT * FROM "${table}"`;
        const values = [];
    
        if (keys.length > 0) {
            sql += ' WHERE ' + keys
                .map(key => {
                    if (filters[key] === null) {
                        return `"${key}" IS NULL`;
                    }
    
                    values.push(filters[key]);
                    return `"${key}" = ?`;
                })
                .join(' AND ');
        }
    
        return this.db.all(sql, values);
    }
    
    /**
     * Get metadata.
     *
     * @returns {Promise<Object>}
     */
    async getMetadata() {
        return this.db.get(`
            SELECT player_count, leaderboard_updated_at, kills_updated_at, nesting_updated_at,
                playtime_updated_at, meat_updated_at, bones_updated_at
            FROM metadata WHERE id = 1
        `);
    }
    
    /**
     * Update the leaderboard timestamp.
     *
     * @returns {Promise<void>}
     */
    async updateLeaderboardTimestamp(sources = []) {
        const sourceColumns = {
            kills: 'kills_updated_at',
            nesting: 'nesting_updated_at',
            playtime: 'playtime_updated_at',
            meat: 'meat_updated_at',
            bones: 'bones_updated_at'
        };
        const columns = [...new Set(sources)].map(source => sourceColumns[source]);
        if (columns.some(column => !column)) {
            throw new Error('Invalid leaderboard source');
        }
        const assignments = [
            "leaderboard_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            ...columns.map(column => `"${column}" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
        ];
        await this.db.run(`UPDATE metadata SET ${assignments.join(', ')} WHERE id = 1`);
    }

    async markLeaderboardSourcesStale(sources) {
        const sourceColumns = {
            kills: 'kills_updated_at',
            nesting: 'nesting_updated_at',
            playtime: 'playtime_updated_at',
            meat: 'meat_updated_at',
            bones: 'bones_updated_at'
        };
        const columns = [...new Set(sources)].map(source => sourceColumns[source]);
        if (columns.some(column => !column)) {
            throw new Error('Invalid leaderboard source');
        }
        if (columns.length === 0) return;
        await this.db.run(
            `UPDATE metadata SET ${columns.map(column => `"${column}" = NULL`).join(', ')} WHERE id = 1`
        );
    }

    /**
     * Return minutes since this user's latest note about a player. Returns null if no matching note
     * exists.
     */
    async getMinutesSinceLatestNote(discordId, player) {
        if (!discordId) {
            throw new Error('discordId is required');
        }

        const playerName = typeof player === 'string' ? player.trim() : player?.steam_name;
        if (!playerName) throw new Error('player is required');
        const aliases = typeof player === 'string'
            ? [playerName]
            : [...new Set([
                player.steam_name, player.steam_id, player.discord_name, player.discord_id
            ].filter(Boolean))];

        const row = await this.db.get(`
            SELECT created_at
            FROM notes
            WHERE from_discord_id = ?
                AND (
                    (? IS NOT NULL AND to_steam_id = ?)
                    OR (to_steam_id IS NULL AND to_steam_name COLLATE NOCASE IN (
                        ${aliases.map(() => '?').join(', ')}
                    ))
                )
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        `, [
            String(discordId), player?.steam_id ?? null, player?.steam_id ?? null, ...aliases
        ]);

        if (!row) {
            return null;
        }

        const createdAtMs = Date.parse(row.created_at);

        if (!Number.isFinite(createdAtMs)) {
            throw new Error(`Invalid created_at timestamp: ${row.created_at}`);
        }

        return Math.max(0, (Date.now() - createdAtMs) / 60000);
    }
}

module.exports = DatabaseManager;