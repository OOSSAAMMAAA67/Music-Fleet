'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(`[dependency-preflight] FAIL: ${message}`);
  process.exitCode = 1;
}

try { require('../utils/nodeRuntime').assertSupportedRuntime(); }
catch (error) { fail(error.message); process.exit(1); }

const required = [
  'discord.js',
  '@discordjs/voice',
  'prism-media',
  'opusscript',
  'libsodium-wrappers',
  'tweetnacl',
  'chalk',
  'sharp',
  '@ffmpeg-installer/ffmpeg',
  'hls.js',
  'kuromoji',
  'pinyin-pro',
  'aromanize',
];

for (const name of required) {
  try {
    const mod = require(name);
    if (!mod) throw new Error('module returned no exports');
    console.log(`[dependency-preflight] OK ${name}`);
  } catch (err) {
    fail(`${name}: ${err?.message || err}`);
  }
}

let opusBackend = '';
try { require('@discordjs/opus'); opusBackend = '@discordjs/opus'; }
catch (_) {
  try { require('opusscript'); opusBackend = 'opusscript'; }
  catch (err) { fail(`no Opus backend available: ${err?.message || err}`); }
}
if (opusBackend) console.log(`[dependency-preflight] OK opus backend: ${opusBackend}`);

try {
  const sharp = require('sharp');
  if (!sharp?.versions?.sharp) throw new Error('sharp native runtime did not report a version');
  console.log(`[dependency-preflight] OK sharp runtime ${sharp.versions.sharp}`);
} catch (err) {
  fail(`sharp runtime: ${err?.message || err}`);
}

try {
  const ffmpeg = require('@ffmpeg-installer/ffmpeg');
  if (!ffmpeg?.path || !fs.existsSync(ffmpeg.path)) throw new Error(`bundled FFmpeg missing at ${ffmpeg?.path || '(no path)'}`);
  console.log(`[dependency-preflight] OK bundled FFmpeg: ${path.basename(ffmpeg.path)}`);
} catch (err) {
  fail(`FFmpeg runtime: ${err?.message || err}`);
}

try {
  const voice = require('@discordjs/voice');
  if (typeof voice.generateDependencyReport === 'function') {
    const report = voice.generateDependencyReport();
    if (!/discordjs\/voice/i.test(report)) throw new Error('voice dependency report unavailable');
    console.log('[dependency-preflight] OK Discord voice dependency report');
  }
} catch (err) {
  fail(`Discord voice runtime: ${err?.message || err}`);
}

if (!process.exitCode) console.log(`[dependency-preflight] PASS on ${process.version} (${process.platform}/${process.arch})`);
