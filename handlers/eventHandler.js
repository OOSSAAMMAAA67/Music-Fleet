const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { runWithClient } = require('../utils/playerContext');

function loadEvents(client) {
    const eventsPath = path.join(__dirname, "..", "events");
    const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith(".js"));

    let loaded = 0;
    for (const file of eventFiles) {
        try {
            const event = require(path.join(eventsPath, file));
            if (!event.name) continue;

            const listener = (...args) => {
                Promise.resolve().then(() => runWithClient(client, () => event.execute(...args, client)))
                    .catch(err => console.error(`[${client.botKey || 'bot'}:${event.name}]`, client.fleet?.safeError?.(err) || err.message || 'event failed'));
            };
            if (event.once) client.once(event.name, listener);
            else client.on(event.name, listener);
            loaded++;
        } catch (err) {
            console.log(chalk.red(`  ❌ فشل تحميل الحدث: ${file}`));
            console.log(chalk.gray(`     ${err.message}`));
        }
    }

    if (!client.botKey || client.botKey === client.fleet?.definitions?.[0]?.key) console.log(chalk.green(`  ✅ تم تحميل ${loaded} حدث بنجاح`));
}

module.exports = { loadEvents };
