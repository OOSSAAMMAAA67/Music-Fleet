const { GatewayIntentBits, IntentsBitField } = require('discord.js');
const { generateDependencyReport } = require('@discordjs/voice');
const config = require('../config');

console.log('Music By ! A Voice Debug');
console.log('Node:', process.version);
console.log('Platform:', process.platform, process.arch);
console.log('discord.js:', require('discord.js').version);
console.log('@discordjs/voice:', generateDependencyReport().match(/@discordjs\/voice: ([^\n]+)/)?.[1] || 'installed');
console.log('Configured TOKEN:', config.TOKEN && !String(config.TOKEN).includes('PUT_') ? 'present' : 'missing');
const intents = new IntentsBitField([
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMembers,
]);
console.log('Intent GuildVoiceStates in fixed index.js should be:', intents.has(GatewayIntentBits.GuildVoiceStates) ? 'OK' : 'MISSING');
console.log('');
console.log(generateDependencyReport());
