const { _playQuery } = require("./play");

module.exports = {
    name: "اضف",
    aliases: ["أضف", "add", "queueadd", "ضيف", "حط"],
    description: "إضافة أغنية إلى نهاية القائمة بدون قطع الأغنية الحالية",
    usage: "اضف [اسم الأغنية أو رابط]",

    async execute(message, args, client) {
        return _playQuery(message, args, client, { forceNow: false, queueOnly: true });
    },
};
