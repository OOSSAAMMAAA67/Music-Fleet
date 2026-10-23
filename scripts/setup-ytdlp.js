const fs = require('fs');
const path = require('path');
const https = require('https');
const { createHash } = require('node:crypto');
const { spawnSync } = require('child_process');
const { pipeline } = require('node:stream/promises');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const SOFT = process.argv.includes('--soft');
const IS_WIN = process.platform === 'win32';
const config = require('../config');
const UPDATE_CHANNEL = String(config.YTDLP_UPDATE_CHANNEL || 'stable').trim().toLowerCase();

function log(msg) { console.log(`[setup-ytdlp] ${msg}`); }

async function check() {
  try {
    const info = await require('../utils/ytDlpProvider').checkAvailability();
    log(`OK: ${info.version} (${info.label})`);
    return true;
  } catch (err) {
    log(`not ready: ${String(err.message || err).split('\n')[0]}`);
    return false;
  }
}

function run(cmd, args) {
  log(`running: ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  return result.status === 0;
}

async function tryPipInstall() {
  const commands = IS_WIN
    ? [
        ['py', ['-3', '-m', 'pip', 'install', '--user', '-U', 'yt-dlp[default]']],
        ['python', ['-m', 'pip', 'install', '--user', '-U', 'yt-dlp[default]']],
      ]
    : [
        ['python3', ['-m', 'pip', 'install', '--user', '-U', 'yt-dlp[default]']],
        ['python', ['-m', 'pip', 'install', '--user', '-U', 'yt-dlp[default]']],
      ];

  for (const [cmd, args] of commands) {
    if (run(cmd, args) && await check()) return true;
  }
  return false;
}

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Music-By-A-installer' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      pipeline(res, fs.createWriteStream(dest, { flags: 'wx' })).then(resolve, reject);
    });
    req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}


function portablePath() {
  return path.join(BIN, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
}

async function tryUpdateExisting() {
  const portable = portablePath();

  // إذا كنا نستعمل binary محلي رسمي فـ -U هو أسرع وأأمن طريقة لتحديثه.
  if (fs.existsSync(portable)) {
    try {
      log('checking portable yt-dlp update...');
      if (run(portable, UPDATE_CHANNEL === 'nightly' ? ['-U', '--update-to', 'nightly'] : ['-U']) && await check()) return true;
    } catch (_) {}

    // تحقق من التنزيل المؤقت قبل استبدال النسخة المحلية التي تعمل.
    if (await tryDownloadPortable()) return true;
    // A failed portable update must keep the local working build. Updating a
    // separate global Python environment cannot repair this portable file.
    return false;
  }

  if (IS_WIN && await tryDownloadPortable()) return true;
  // في تثبيت Python، pip -U يحدّث yt-dlp مع المحافظة على طريقة التشغيل الحالية.
  if (await tryPipInstall()) return true;
  return false;
}
async function tryDownloadPortable() {
  const fileName = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
  const releaseUrl = UPDATE_CHANNEL === 'nightly'
    ? 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  const url = `${releaseUrl}/${fileName}`;
  const dest = path.join(BIN, fileName);
  const temp = path.join(BIN, `yt-dlp.part-${process.pid}-${Date.now()}${IS_WIN ? '.exe' : ''}`);
  const manifestFile = `${temp}.sha256`;
  try {
    log(`downloading portable binary to: ${dest}`);
    await download(`${releaseUrl}/SHA2-256SUMS`, manifestFile);
    const manifest = fs.readFileSync(manifestFile, 'utf8');
    const expected = manifest.split(/\r?\n/).map(line => line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
      .find(match => match && match[2] === fileName)?.[1]?.toLowerCase();
    if (!expected) throw new Error(`The official SHA256 manifest has no checksum for ${fileName}.`);
    await download(url, temp);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(temp)) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new Error(`SHA256 verification failed for ${fileName}.`);
    log(`verified official SHA256 for ${fileName}`);
    if (!IS_WIN) fs.chmodSync(temp, 0o755);
    const result = spawnSync(temp, ['--version'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, shell: false, timeout: 30000,
    });
    if (result.status !== 0 || !/^\d{4}\.\d{2}\.\d{2}[\w.+-]*$/.test(String(result.stdout || '').trim())) {
      throw new Error('Downloaded yt-dlp did not report a valid version.');
    }
    // A failed replacement (including a Windows file lock) preserves dest.
    fs.renameSync(temp, dest);
    return await check();
  } catch (err) {
    log(`portable download failed: ${err.message || err}`);
    return false;
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    try { fs.rmSync(manifestFile, { force: true }); } catch (_) {}
  }
}

(async () => {
  const wasWorking = await check();
  if (wasWorking) {
    log(`working yt-dlp found; checking for a newer ${UPDATE_CHANNEL} build...`);
    if (await tryUpdateExisting()) process.exit(0);
    // فشل التحديث لا يجب أن يكسر نسخة كانت تعمل أصلاً.
    log('update check failed; keeping the existing working yt-dlp.');
    process.exit(0);
  }

  // Windows uses the self-contained local executable first. A successful
  // portable install needs no changes to a user's global Python environment.
  if (IS_WIN && await tryDownloadPortable()) process.exit(0);
  if (await tryPipInstall()) process.exit(0);
  if (!IS_WIN && await tryDownloadPortable()) process.exit(0);

  log('FAILED: yt-dlp could not be installed automatically.');
  log('Manual Windows command: py -3 -m pip install --user -U "yt-dlp[default]"');
  log('Or download yt-dlp.exe and put it in bot-source\\bin\\yt-dlp.exe');
  process.exit(SOFT ? 0 : 1);
})();
