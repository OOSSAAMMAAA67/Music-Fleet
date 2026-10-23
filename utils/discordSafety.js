'use strict';

function errorCode(err) {
    return err?.code ?? err?.rawError?.code ?? err?.data?.code ?? null;
}

function errorText(err) {
    try {
        return [
            err?.message,
            err?.rawError?.message,
            JSON.stringify(err?.rawError?.errors || {}),
            JSON.stringify(err?.errors || {}),
        ].filter(Boolean).join(' | ');
    } catch (_) {
        return String(err?.message || err || '');
    }
}

function isUnknownMessageReference(err) {
    const code = errorCode(err);
    if (code === 10008) return true;
    const text = errorText(err);
    return /MESSAGE_REFERENCE_UNKNOWN_MESSAGE|Unknown message/i.test(text) && /message[_ ]?reference|reference|Unknown message/i.test(text);
}

function installSafeReply(message) {
    if (!message || typeof message.reply !== 'function' || message.__musicSafeReplyInstalled) return message;
    const originalReply = message.reply.bind(message);
    Object.defineProperty(message, '__musicSafeReplyInstalled', { value: true, configurable: true });
    Object.defineProperty(message, 'reply', {
        configurable: true,
        writable: true,
        value: async function safeReply(payload) {
            try {
                return await originalReply(payload);
            } catch (err) {
                if (!isUnknownMessageReference(err) || !message.channel?.send) throw err;
                // The command message was deleted between receipt and reply. Fall back
                // to a normal channel send instead of failing the entire command.
                return message.channel.send(payload);
            }
        },
    });
    return message;
}

module.exports = { isUnknownMessageReference, installSafeReply };
