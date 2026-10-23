const { _playQuery } = require("./play");

module.exports = {
    name: "ش_الان",
    aliases: ["فوري", "شغل_الان", "playnow", "nowplay", "forceplay"],
    description: "تشغيل أغنية فوراً وإيقاف الحالية بدلاً من إضافتها للقائمة",
    usage: "ش_الان [اسم الأغنية أو رابط]",

    async execute(message, args, client) {
        return _playQuery(message, args, client, { forceNow: true });
    },
};
