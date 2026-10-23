'use strict';
function shutdownDeadline(settings = require('../config'), env = process.env) {
    const value = Number(env.FLEET_SHUTDOWN_TIMEOUT_MS || settings.FLEET_SHUTDOWN_TIMEOUT_MS || 30000);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147438647) throw new Error('FLEET_SHUTDOWN_TIMEOUT_MS must be a positive bounded integer.');
    return value;
}
function installProcessShutdown(shutdown, target = process) {
    if (typeof shutdown !== 'function') throw new TypeError('A shutdown callback is required.');
    const onInt = () => void shutdown('SIGINT');
    const onTerm = () => void shutdown('SIGTERM');
    // PM2 on Windows cannot deliver POSIX signals reliably. This IPC command
    // runs the same ledger/storage flush as an ordinary graceful shutdown.
    const onMessage = message => { if (message === 'shutdown') void shutdown('PM2 shutdown'); };
    target.once('SIGINT', onInt); target.once('SIGTERM', onTerm); target.on('message', onMessage);
    return () => { target.removeListener('SIGINT', onInt); target.removeListener('SIGTERM', onTerm); target.removeListener('message', onMessage); };
}
module.exports = { installProcessShutdown, shutdownDeadline };
