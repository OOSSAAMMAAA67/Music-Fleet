const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { OWNER_COMMAND_FILES, PLAYBACK_COMMAND_FILES } = require('../utils/fleetRouting');

function loadCommands(client) {
    const commandsPath = path.join(__dirname, "..", "commands");
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));

    let loaded = 0;
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (!command.name) continue;
            if (OWNER_COMMAND_FILES.has(file)) command.ownerOnly = true;
            if (command.rootOwnerOnly) command.ownerOnly = true;
            if (PLAYBACK_COMMAND_FILES.has(file)) command.requiresAssignedVoice = true;
            if (command.ownerOnly && !command.__ownerGuarded) {
                const execute = command.execute;
                command.execute = function(message, args, selectedClient) {
                    const permissions = require('../utils/permissions');
                    if (command.rootOwnerOnly && !permissions.isRootOwner(message.author.id, selectedClient)) return;
                    if (!permissions.isOwner(message.author.id, selectedClient)) return;
                    return execute.call(this, message, args, selectedClient);
                };
                Object.defineProperty(command, '__ownerGuarded', { value: true });
            }

            client.commands.set(command.name, command);

            if (command.aliases && Array.isArray(command.aliases)) {
                for (const alias of command.aliases) client.aliases.set(alias, command.name);
            }
            loaded++;
        } catch (err) {
            console.log(chalk.red('  ❌ تم تخطي أمر: ' + file));
            console.log(chalk.gray('     ' + err.message));
        }
    }

    if (!client.botKey || client.botKey === client.fleet?.definitions?.[0]?.key) console.log(chalk.green('  ✅ تم تحميل ' + loaded + ' أمر موسيقى'));
}

module.exports = { loadCommands };
