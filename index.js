'use strict';
// Environment is loaded before performanceProfile/config initialize native pools.
const fs = require('node:fs');
const path = require('node:path');
if (require.main === module) {
    try { require('./utils/nodeRuntime').assertSupportedRuntime(); }
    catch (error) { console.error('[Fleet runtime]', error.message); process.exit(1); }
}
if (require.main === module && fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
const performanceProfile = require('./utils/performanceProfile');
const perf = performanceProfile.applyEarlyRuntime();
const { createFleet } = require('./utils/fleetRuntime');
const config = require('./config');

async function startFleet(options = {}) {
    const shutdownTimeout = require('./utils/runtimeLifecycle').shutdownDeadline(options.settings || config);
    const fleet = createFleet(options);
    let stopping = false;
    async function shutdown(signal = 'shutdown', exitCode = 0) {
        if (stopping) return;
        stopping = true;
        console.log('[Fleet] Closing: ' + signal);
        const hardExit = setTimeout(() => process.exit(exitCode || 1), shutdownTimeout);
        hardExit.unref();
        try {
            await require('./utils/webPlayerServer').stop();
            await fleet.close();
            await require('./utils/mediaCache').close();
            if (require('./utils/favoritesStore').flushAll?.({ shutdown: true }) === false) throw new Error('Favorites flush failed.');
            await require('./utils/historyStore').flushAll?.();
            await require('./utils/playlistsStore').flushAll?.();
            await require('./utils/platformStore').flushAll?.();
            await require('./utils/sharedStorage').closeSharedStorage();
        } catch (error) {
            console.error('[Fleet] Shutdown:', fleet._sanitize(error));
            exitCode = 1;
        } finally {
            clearTimeout(hardExit);
            if (require.main === module) process.exit(exitCode);
        }
    }
    fleet.shutdown = shutdown;
    for (const record of fleet.records.values()) record.client.shutdown = shutdown;
    if (require.main === module) {
        require('./utils/runtimeLifecycle').installProcessShutdown(shutdown);
        process.on('unhandledRejection', error => console.error('[Fleet] Rejected:', fleet._sanitize(error)));
        process.once('uncaughtException', error => {
            console.error('[Fleet] Fatal:', fleet._sanitize(error)); void shutdown('uncaughtException', 1);
        });
    }
    console.log('[Fleet] Starting ' + fleet.records.size + ' bot(s), one web service, shared per-user storage.');
    console.log('[Fleet] CPU ' + perf.logicalThreads + ' threads; audio buffer ' + Math.round(Number(config.STREAM_HIGH_WATER_MARK) / 1048576) + ' MB; SQLite worker enabled.');
    void require('./utils/ytDlpProvider').checkAvailability()
        .then(info => console.log('[Fleet] yt-dlp: ' + info.version))
        .catch(error => console.warn('[Fleet] yt-dlp is not ready: ' + fleet._sanitize(error)));
    await fleet.start();
    return fleet;
}

if (require.main === module) startFleet().catch(error => {
    // Configuration errors may contain secrets in downstream libraries; print a
    // redacted first line. Validation never includes token values.
    console.error('[Fleet] Startup failed:', String(error.message || error).replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{15,}/g, '[redacted]'));
    process.exitCode = 1;
});
module.exports = { createFleet, startFleet };
