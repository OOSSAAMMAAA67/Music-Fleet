'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
let fallback;

function runWithClient(client, work) { return context.run(client, work); }
function currentClient() { return context.getStore() || null; }
function getPlayer(client) {
    const selected = client?.player || currentClient()?.player;
    if (selected) return selected;
    // Standalone commands and inherited tests keep their old singleton API.
    // Fleet operation never constructs this extra player.
    if (!fallback) fallback = new (require('./musicPlayer').MusicPlayer)();
    return fallback;
}
function createPlayerProxy() {
    return new Proxy({}, {
        get(_target, key) {
            if (key === 'then') return undefined;
            const player = getPlayer();
            const value = Reflect.get(player, key, player);
            return typeof value === 'function' ? value.bind(player) : value;
        },
        set(_target, key, value) { return Reflect.set(getPlayer(), key, value); },
    });
}
module.exports = { runWithClient, currentClient, getPlayer, createPlayerProxy };
