const { spawnSync } = require('child_process');
const config = require('../config');
const { resolveFfmpegPath, resolveAudioFilter } = require('../utils/ffmpegResolver');

const ffmpegPath = resolveFfmpegPath(true);
process.env.FFMPEG_PATH = ffmpegPath;
const result = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
if (result.error || result.status !== 0) {
  console.error('[FAIL] FFmpeg:', result.error?.message || result.stderr || `exit ${result.status}`);
  process.exit(1);
}
const firstLine = String(result.stdout || result.stderr || '').split(/\r?\n/)[0];
console.log('[OK] FFmpeg:', ffmpegPath);
console.log(firstLine);

// -version succeeds even when the selected resampler fails on the first song.
const filter = resolveAudioFilter(ffmpegPath, config.FFMPEG_AUDIO_FILTER);
const audio = spawnSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error', '-nostdin',
  '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
  ...(filter ? ['-af', filter] : []),
  '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1',
], { input: Buffer.alloc(4410 * 4), windowsHide: true, timeout: 8000 });
if (audio.error || audio.status !== 0 || audio.stdout.length === 0) {
  console.error('[FAIL] FFmpeg audio conversion:', audio.error?.message || String(audio.stderr) || `exit ${audio.status}`);
  process.exit(1);
}
console.log('[OK] 44.1 kHz -> 48 kHz stereo audio conversion produced real PCM');
