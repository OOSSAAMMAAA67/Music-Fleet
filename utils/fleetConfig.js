'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// A bot's token begins with its base64-encoded Discord account snowflake. The
// account ID stays stable after a token rotation or a token-list reorder.
function tokenAccountId(token) {
    const first = String(token).split('.')[0];
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(first)) return null;
    try {
        const decoded = Buffer.from(first, 'base64url').toString('utf8');
        return /^\d{16,22}$/.test(decoded) ? decoded : null;
    } catch (_) { return null; }
}

function usableToken(value) {
    if (typeof value !== 'string') return null;
    const token = value.trim();
    if (!token || /\s/.test(token)) return null;
    if (/^(?:your|put|paste|insert|replace|change|example|sample|test)[_-].*token/i.test(token)
        || /^(?:bot[_-]?)?token(?:[_-](?:here|placeholder|\d+))?$/i.test(token)
        || /[<>]|توكن|التوكن/.test(token)) return null;
    return token;
}

function loadBotDefinitions(config = {}, { env = process.env, baseDir = path.resolve(__dirname, '..') } = {}) {
    let entries;
    if (typeof env.BOT_TOKENS === 'string' && env.BOT_TOKENS.trim()) {
        try { entries = JSON.parse(env.BOT_TOKENS); }
        catch (_) { throw new Error('BOT_TOKENS must contain a JSON array of bot tokens.'); }
    } else if (config.TOKEN_LIST != null && (!Array.isArray(config.TOKEN_LIST) || config.TOKEN_LIST.length)) {
        entries = config.TOKEN_LIST;
    } else {
        const tokenFile = path.resolve(baseDir, config.TOKENS_FILE || 'tokens.txt');
        try {
            entries = fs.readFileSync(tokenFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error('Unable to read the bot token file.');
        }
        if (!entries?.length) entries = [env.TOKEN || config.TOKEN];
    }
    if (!Array.isArray(entries) || !entries.length) throw new Error('Configure at least one bot token in TOKEN_LIST, BOT_TOKENS or tokens.txt.');
    const limit = config.FLEET_MAX_BOTS == null ? 100 : Number(config.FLEET_MAX_BOTS);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('FLEET_MAX_BOTS must be a positive integer.');
    if (entries.length > limit) throw new Error(`The bot list exceeds FLEET_MAX_BOTS (${limit}).`);

    const tokens = new Set();
    const keys = new Set();
    return entries.map((entry, index) => {
        const object = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
        const token = usableToken(object ? object.token : entry);
        if (!token) throw new Error(`Bot token at position ${index + 1} is missing or a placeholder.`);
        if (tokens.has(token)) throw new Error(`Duplicate bot token at position ${index + 1}.`);
        tokens.add(token);
        const explicitId = object?.id == null ? null : String(object.id).trim();
        if (explicitId && !/^[A-Za-z0-9_-]{1,100}$/.test(explicitId)) throw new Error(`Bot ID at position ${index + 1} is invalid.`);
        const key = tokenAccountId(token) || explicitId || `bot-${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
        if (keys.has(key)) throw new Error(`Duplicate bot account at position ${index + 1}.`);
        keys.add(key);
        const definition = { key, token, main: index === 0 };
        if (typeof object?.name === 'string' && object.name.trim()) definition.name = object.name.trim().slice(0, 100);
        return definition;
    });
}

module.exports = { loadBotDefinitions };
