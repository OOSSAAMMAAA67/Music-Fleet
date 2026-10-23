'use strict';

const { isRootOwner } = require('../utils/permissions');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SAFE_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function getImageAttachment(message) {
    const attachments = [...(message.attachments?.values?.() || [])];
    if (attachments.length !== 1) throw new Error('أرفق صورة واحدة مع الأمر avatarall.');
    const attachment = attachments[0];
    let url;
    try { url = new URL(attachment.url); } catch (_) { throw new Error('رابط الصورة غير صالح.'); }
    if (url.protocol !== 'https:' || !SAFE_CDN_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
        throw new Error('أرسل الصورة كمرفق Discord من دون رابط خارجي.');
    }
    if (Number(attachment.size) > MAX_IMAGE_BYTES) throw new Error('حجم الصورة يتجاوز 8 MB.');
    const contentType = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
        throw new Error('المرفق ليس صورة.');
    }
    return { url: url.toString(), contentType };
}

function imageType(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

async function downloadAvatar(attachment) {
    const response = await fetch(attachment.url, {
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
    });
    if (!response.ok) throw new Error('تعذر تنزيل الصورة من Discord (HTTP ' + response.status + ').');

    const headerLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(headerLength) && headerLength > MAX_IMAGE_BYTES) throw new Error('حجم الصورة يتجاوز 8 MB.');

    const chunks = [];
    let total = 0;
    const reader = response.body?.getReader?.();
    if (reader) {
        try {
            while (true) {
                const item = await reader.read();
                if (item.done) break;
                const chunk = Buffer.from(item.value);
                total += chunk.length;
                if (total > MAX_IMAGE_BYTES) {
                    await reader.cancel().catch(() => {});
                    throw new Error('حجم الصورة يتجاوز 8 MB.');
                }
                chunks.push(chunk);
            }
        } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
        } finally {
            try { reader.releaseLock(); } catch (_) {}
        }
    } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('حجم الصورة يتجاوز 8 MB.');
        chunks.push(bytes);
        total = bytes.length;
    }

    const image = Buffer.concat(chunks, total);
    if (!imageType(image)) throw new Error('صيغة الصورة غير مدعومة. استخدم PNG أو JPEG أو GIF أو WEBP.');
    return image;
}

function botName(record) {
    return String(record?.client?.user?.username || record?.key || 'bot').replace(/[\r\n@]/g, '_').slice(0, 50);
}

function shortFailure(error) {
    const status = Number(error?.status || error?.statusCode);
    if (status) return 'HTTP ' + status;
    if (error?.code === 'UND_ERR_CONNECT_TIMEOUT' || error?.name === 'TimeoutError') return 'انتهت المهلة';
    return 'رفض Discord تغيير الصورة';
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function editStatus(statusMessage, content) {
    try { await statusMessage.edit({ content, allowedMentions: { parse: [] } }); } catch (_) {}
}

module.exports = {
    name: 'avatarall',
    aliases: ['allavatars', 'setavatars'],
    ownerOnly: true,
    rootOwnerOnly: true,
    fleetControl: true,
    description: 'تغيير صورة جميع البوتات الجاهزة في الأسطول (المالك الأساسي فقط)',
    usage: 'avatarall [أرفق صورة]',
    async execute(message, _args, client) {
        if (!isRootOwner(message.author.id, client)) return;
        const fleet = client.fleet;
        if (!fleet?.records?.values) return message.reply('❌ خدمة الأسطول غير جاهزة.');
        let attachment;
        try { attachment = getImageAttachment(message); }
        catch (error) { return message.reply({ content: '❌ ' + error.message, allowedMentions: { parse: [] } }); }

        const records = [...fleet.records.values()];
        const ready = records.filter(record => record.status === 'ready'
            && record.client?.user && record.client?.isReady?.());
        const unavailable = records.length - ready.length;
        if (!ready.length) return message.reply('❌ لا توجد بوتات جاهزة لتغيير صورها.');

        const status = await message.reply({
            content: '⏳ جارٍ تغيير الصور تدريجيًا لـ ' + ready.length + ' بوت. قد يستغرق الأمر بعض الوقت.',
            allowedMentions: { parse: [] },
        });

        let image;
        try { image = await downloadAvatar(attachment); }
        catch (error) {
            await editStatus(status, '❌ ' + error.message);
            return;
        }

        const succeeded = [];
        const failed = [];
        let skipped = 0;
        for (let index = 0; index < ready.length; index++) {
            if (index > 0) await delay(1000);
            const record = ready[index];
            const botClient = record.client;
            if (fleet.recordForClient?.(botClient) !== record || !botClient.isReady?.() || !botClient.user) {
                skipped++;
                continue;
            }
            try {
                await botClient.user.setAvatar(image);
                succeeded.push(botName(record));
            } catch (error) {
                failed.push({ name: botName(record), reason: shortFailure(error) });
            }
            if ((index + 1) % 10 === 0) {
                await editStatus(status, '⏳ التقدم: ' + (index + 1) + '/' + ready.length + ' بوت.');
            }
        }

        const lines = [
            '✅ اكتمل تحديث صور الأسطول.',
            'نجح: ' + succeeded.length + '/' + ready.length,
            'تخطّى: ' + (unavailable + skipped),
            'فشل: ' + failed.length,
        ];
        if (failed.length) {
            lines.push('تعذر التحديث: ' + failed.slice(0, 8).map(item => item.name + ' (' + item.reason + ')').join('، '));
            if (failed.length > 8) lines.push('وأخفق ' + (failed.length - 8) + ' بوتات أخرى.');
        }
        await editStatus(status, lines.join('\n'));
    },
    _test: { getImageAttachment, imageType, downloadAvatar },
};
