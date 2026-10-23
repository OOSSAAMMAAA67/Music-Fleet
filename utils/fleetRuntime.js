'use strict';
const { Client, GatewayIntentBits, Partials, Collection, Options } = require('discord.js');
const path = require('node:path');
const config = require('../config');
const { loadBotDefinitions } = require('./fleetConfig');
const { FleetState } = require('./fleetState');
const { FleetManager } = require('./fleetManager');
const { MusicPlayer } = require('./musicPlayer');

function validateRuntimeConfiguration(settings) {
    if (settings.OPUS_FRAME_SIZE != null && Number(settings.OPUS_FRAME_SIZE) !== 960) throw new Error('OPUS_FRAME_SIZE must be 960 (20ms at48kHz) for Discord voice.');
    for (const name of ['FAVORITES_MAX_PER_USER', 'HISTORY_MAX_TRACKS', 'PLAYLISTS_MAX_PER_USER', 'PLAYLIST_MAX_TRACKS', 'PLATFORM_COLLECTION_MAX_ITEMS', 'PLATFORM_FEEDBACK_MAX_ITEMS', 'PLATFORM_HISTORY_MAX_EVENTS']) {
        if (settings[name] != null) require('./storageLimits').storageLimit(name, 0, settings[name]);
    }
    const limits = { STREAM_HIGH_WATER_MARK: [65536, 128 * 1048576], FLEET_MESSAGE_CACHE: [0, 100], FLEET_MEMBER_CACHE: [1, 10000], FLEET_USER_CACHE: [1, 10000] };
    for (const [name, [minimum, maximum]] of Object.entries(limits)) {
        if (settings[name] == null) continue;
        const value = Number(settings[name]);
        if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}; expected ${minimum}..${maximum}.`);
    }
}
function clientOptions(settings = config) {
    return {
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
        partials: [Partials.Message, Partials.Channel],
        allowedMentions: { parse: [], repliedUser: false },
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            MessageManager: Number(settings.FLEET_MESSAGE_CACHE ?? 8),
            GuildMemberManager: { maxSize: Number(settings.FLEET_MEMBER_CACHE ?? 64), keepOverLimit: member => member.id === member.client.user?.id },
            UserManager: { maxSize: Number(settings.FLEET_USER_CACHE ?? 256), keepOverLimit: user => user.id === user.client.user?.id },
            ReactionManager: 0, PresenceManager: 0, GuildScheduledEventManager: 0,
        }),
        sweepers: { ...Options.DefaultSweeperSettings, messages: { interval: 300, lifetime: 300 } },
    };
}
function chooseAudioPipeline(botCount, settings = config) {
    const preferred = String(settings.AUDIO_PIPELINE_MODE || 'hq-opus');
    const scalable = String(settings.FLEET_AUDIO_PIPELINE_MODE ?? 'ffmpeg-opus').trim();
    return scalable && botCount >= Math.max(1, Number(settings.FLEET_AUDIO_THRESHOLD || 8)) ? scalable : preferred;
}
function createFleet({ settings = config, definitions, state, createClient, createPlayer, logger = console } = {}) {
    validateRuntimeConfiguration(settings);
    const bots = definitions || loadBotDefinitions(settings, { baseDir: path.join(__dirname, '..') });
    settings.AUDIO_PIPELINE_MODE = chooseAudioPipeline(bots.length, settings);
    const roots = [process.env.OWNER_ID || settings.OWNER_ID, ...(settings.OWNER_IDS || [])].filter(Boolean);
    if (!roots.length || roots.some(id => !/^\d{5,32}$/.test(String(id)))) throw new Error('Configure a valid OWNER_ID or OWNER_IDS before starting.');
    return new FleetManager({ definitions: bots, rootOwnerIds: roots, config: settings, logger,
        state: state || new FleetState({ filePath: path.join(process.env.DATA_DIR || settings.DATA_DIR || path.join(__dirname, '..', 'data'), 'fleet-state.json') }),
        createClient: createClient || (definition => {
            const client = new Client(clientOptions(settings));
            client.botKey = definition.key;
            client.commands = new Collection(); client.aliases = new Collection(); client.prefixes = new Map(); client.config = settings;
            client._fleetTimers = new Set();
            require('../handlers/commandHandler').loadCommands(client);
            require('../handlers/eventHandler').loadEvents(client);
            client.on('shardError', error => logger.warn(`[${definition.key}] Gateway: ${client.fleet?._sanitize?.(error) || error.message}`));
            return client;
        }),
        createPlayer: createPlayer || ((definition, client) => new MusicPlayer({ group: definition.key, client })),
    });
}
module.exports = { createFleet, clientOptions, validateRuntimeConfiguration, chooseAudioPipeline };
