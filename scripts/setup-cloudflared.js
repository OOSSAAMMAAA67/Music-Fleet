'use strict';

const config = require('../config');
const gateway = require('../utils/globalWebGateway');

function envBool(name, fallback) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw);
}

(async () => {
    try {
        const enabled = envBool('WEB_PLAYER_GLOBAL_ACCESS', config.WEB_PLAYER_GLOBAL_ACCESS !== false);
        const mode = String(process.env.WEB_PLAYER_GLOBAL_MODE || config.WEB_PLAYER_GLOBAL_MODE || 'auto').trim().toLowerCase();
        const token = String(process.env.CLOUDFLARE_TUNNEL_TOKEN || config.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
        const publicUrl = String(process.env.WEB_PLAYER_PUBLIC_URL || config.WEB_PLAYER_PUBLIC_URL || '').trim();
        const manualAuto = mode === 'auto' && publicUrl && !token;
        if (!enabled || mode === 'off' || mode === 'manual' || manualAuto) {
            console.log('[OK] Managed cloudflared gateway is not required by the current configuration.');
            return;
        }
        const binary = await gateway.ensureBinary();
        console.log(`[OK] cloudflared ready: ${binary}`);
    } catch (err) {
        console.error(`[ERROR] cloudflared setup failed: ${err.message || err}`);
        process.exitCode = 1;
    }
})();
