const chalk = require("chalk");
const config = require("../config");
const activity = require('../utils/activityManager');

async function registerPrivateCommands(client) {
    // Upsert only these two commands; do not replace other application commands.
    for (const command of [
        { name: 'سكب', description: 'تخطي الأغنية مع رد خاص يظهر لك وحدك' },
        { name: 'skip', description: 'Skip the track with a private confirmation' },
    ]) {
        await client.application.commands.create(command);
    }
}

async function startWebWithRetry(client, player, schedule = setTimeout) {
    if (typeof client.isReady === 'function' && !client.isReady()) return false;
    try {
        if (client.fleet?._closed) return false;
        await require('../utils/webPlayerServer').start({ client, player, fleet: client.fleet });
        return true;
    } catch (err) {
        console.warn(chalk.yellow('  ⚠️  Web Player لم يبدأ؛ ستتم إعادة المحاولة:'), err.message || err);
        const timer = schedule(() => startWebWithRetry(client.fleet?.controlClient() || client, client.fleet?.controlClient()?.player || player, schedule), 30_000);
        timer?.unref?.();
        client._webRetryTimer = timer;
        client._fleetTimers?.add(timer);
        return false;
    }
}

module.exports = {
    name: "clientReady",   // << discord.js v14 يوصي بـ clientReady بدلاً من ready
    once: true,
    async execute(client) {
        console.log(chalk.green(`  ✅ تم تسجيل الدخول كـ: ${client.user.tag}`));
        console.log(chalk.blue(`  🌐 متصل بـ ${client.guilds.cache.size} سيرفر`));
        if (client.fleet) void client.fleet.onReady(client).catch(err => console.warn('[Fleet restore]', err.message));

        if (config.WEB_PLAYER_ENABLED !== false && (!client.fleet || client.fleet.controlClient() === client)) {
            const player = client.player || require('../commands/play')._player;
            void startWebWithRetry(client, player);
        }

        void registerPrivateCommands(client).catch(err => {
            console.warn(chalk.yellow('  ⚠️  تعذر تسجيل أوامر /سكب و/skip:'), err.message || err);
        });

        // Use one persistent fleet-wide activity. The default is "By ! A";
        // owner changes and removal are applied to every connected bot.
        void activity.applyTo(client.fleet || client).catch(error => {
            console.warn(chalk.yellow('  ⚠️  تعذر تطبيق نشاط البوت:'), error.message || error);
        });
    },
};
module.exports.startWebWithRetry = startWebWithRetry;
module.exports.registerPrivateCommands = registerPrivateCommands;
