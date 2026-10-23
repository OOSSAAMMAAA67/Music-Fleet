'use strict';
const path = require('node:path');
const config = require('./config');
// PM2 must outlive the fleet's own shutdown deadline so SQLite/owner pins drain.
const shutdown = Number(process.env.FLEET_SHUTDOWN_TIMEOUT_MS || 30000);
if (!Number.isSafeInteger(shutdown) || shutdown < 1 || shutdown > 2147438647) {
  throw new Error('FLEET_SHUTDOWN_TIMEOUT_MS must be a positive bounded integer.');
}
const heap = Number(process.env.NODE_HEAP_MB ?? config.PERFORMANCE_NODE_HEAP_MB ?? 0);
if (!Number.isSafeInteger(heap) || heap < 0 || heap > 262144) {
  throw new Error('NODE_HEAP_MB must be 0 (Node default) or an integer between 128 and 262144.');
}
module.exports = {
  apps: [{
    name: 'Music By ! A',
    cwd: __dirname,
    script: path.join(__dirname, 'index.js'),
    interpreter: process.env.MUSIC_NODE_EXECUTABLE || process.execPath,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    shutdown_with_message: true,
    kill_timeout: Math.max(45000, shutdown + 10000),
    max_restarts: 30,
    restart_delay: 3000,
    node_args: heap > 0 ? ['--max-old-space-size=' + heap] : [],
    env: {
      // Let utils/performanceProfile.js derive libuv/native worker budgets from
      // the actual machine instead of pinning PM2 to an old 6C/6T profile.
      MUSIC_PERF_PROFILE: 'auto-high-performance'
    }
  }]
};
