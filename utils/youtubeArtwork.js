'use strict';

function isYoutubeArtwork(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && /^(?:i\d?\.ytimg\.com|img\.youtube\.com)$/.test(parsed.hostname) && /^\/(?:vi|vi_webp)\/[\w-]{11}\//.test(parsed.pathname); }
    catch (_) { return false; }
}

// Only delivery thumbnails are cropped. Album art, including intentional
// black borders, keeps its original bytes. Decode a small probe for the edge
// scan and extract from the original image without upscaling.
async function cropYoutubeArtwork(bytes, url) {
    if (!isYoutubeArtwork(url)) return bytes;
    try {
        const sharp = require('sharp'), meta = await sharp(bytes).metadata();
        if (!meta.width || !meta.height || meta.pages > 1) return bytes;
        const { data, info } = await sharp(bytes).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const { width, height, channels } = info;
        const black = (x, y) => { const i = (y * width + x) * channels; return data[i] <= 18 && data[i + 1] <= 18 && data[i + 2] <= 18; };
        const row = y => { let count = 0; for (let x = 0; x < width; x++) if (black(x, y)) count++; return count >= width * .99; };
        const column = x => { let count = 0; for (let y = 0; y < height; y++) if (black(x, y)) count++; return count >= height * .99; };
        let top = 0, bottom = 0, left = 0, right = 0;
        while (top < height * .3 && row(top)) top++;
        while (bottom < height * .3 && row(height - 1 - bottom)) bottom++;
        while (left < width * .3 && column(left)) left++;
        while (right < width * .3 && column(width - 1 - right)) right++;
        if (top >= height * .3 || bottom >= height * .3 || Math.abs(top - bottom) > 3 || top < 2 || bottom < 2) top = bottom = 0;
        if (left >= width * .3 || right >= width * .3 || Math.abs(left - right) > 3 || left < 2 || right < 2) left = right = 0;
        if (!top && !left) return bytes;
        const x = Math.ceil(left * meta.width / width), y = Math.ceil(top * meta.height / height);
        const croppedWidth = meta.width - x - Math.ceil(right * meta.width / width), croppedHeight = meta.height - y - Math.ceil(bottom * meta.height / height);
        if (croppedWidth < meta.width * .4 || croppedHeight < meta.height * .4) return bytes;
        return await sharp(bytes).extract({ left: x, top: y, width: croppedWidth, height: croppedHeight }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    } catch (_) { return bytes; }
}
module.exports = { cropYoutubeArtwork, isYoutubeArtwork };
