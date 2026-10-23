'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ActivityType } = require('discord.js');
const config = require('../config');

const DEFAULT_TEXT = 'By ! A';
const MAX_ACTIVITY_CHARACTERS = 128;
const DATA_DIR = process.env.DATA_DIR || config.DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_FILE_PATH = path.join(DATA_DIR, 'fleet-activity.json');

function validateText(value) {
    if (typeof value !== 'string') throw new Error('اكتب اسم النشاط أو off لإزالته.');
    const text = value.trim();
    if (!text || /[\r\n\0]/.test(text) || [...text].length > MAX_ACTIVITY_CHARACTERS) {
        throw new Error('اسم النشاط مطلوب، وبحد أقصى 128 حرفاً في سطر واحد.');
    }
    return text;
}

function normalize(value, defaultText) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') {
        throw new Error('ملف نشاط الأسطول غير صالح.');
    }
    return value.enabled
        ? { enabled: true, text: validateText(value.text) }
        : { enabled: false, text: typeof value.text === 'string' && value.text.trim()
            ? validateText(value.text) : defaultText };
}

function createActivityManager({ filePath = DEFAULT_FILE_PATH, defaultText = DEFAULT_TEXT,
    activityType = ActivityType.Playing, logger = console } = {}) {
    let current = { enabled: true, text: validateText(defaultText) };
    let writeTail = Promise.resolve();
    try {
        current = normalize(JSON.parse(fs.readFileSync(filePath, 'utf8')), defaultText);
    } catch (error) {
        if (error.code !== 'ENOENT') logger.warn?.('[activity] Saved activity could not be loaded; using the default.');
    }

    function get() { return { ...current }; }
    function clientsFrom(target) {
        if (target?.records instanceof Map) {
            return [...new Set([...target.records.values()].map(record => record?.client).filter(Boolean))];
        }
        return target ? [target] : [];
    }
    async function applyOne(client, preference = current) {
        if (!client?.user?.setPresence || (typeof client.isReady === 'function' && !client.isReady())) return false;
        const presence = {
            activities: preference.enabled ? [{ name: preference.text, type: activityType }] : [],
            status: 'online',
        };
        await client.user.setPresence(presence);
        return true;
    }
    async function applyTo(target) {
        const clients = clientsFrom(target);
        const settled = await Promise.allSettled(clients.map(client => applyOne(client)));
        return {
            targetCount: clients.length,
            appliedCount: settled.filter(item => item.status === 'fulfilled' && item.value).length,
            failedCount: settled.filter(item => item.status === 'rejected').length,
        };
    }
    function save(next) {
        const operation = writeTail.then(async () => {
            const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
            let handle;
            try {
                await fsp.mkdir(path.dirname(filePath), { recursive: true });
                handle = await fsp.open(temporary, 'wx', 0o600);
                await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
                await handle.sync();
                await handle.close(); handle = null;
                await fsp.rename(temporary, filePath);
                current = next;
            } catch (error) {
                await handle?.close().catch(() => {});
                await fsp.unlink(temporary).catch(() => {});
                throw error;
            }
        });
        writeTail = operation.catch(() => {});
        return operation;
    }
    async function update(next, target) {
        await save(next);
        const applied = await applyTo(target);
        return { preference: get(), ...applied };
    }
    return {
        get,
        applyTo,
        setText(value, target) { return update({ enabled: true, text: validateText(value) }, target); },
        clear(target) { return update({ enabled: false, text: current.text || defaultText }, target); },
    };
}

const defaultManager = createActivityManager();
module.exports = { DEFAULT_TEXT, MAX_ACTIVITY_CHARACTERS, createActivityManager, ...defaultManager };
