// ============================================================
//           إعدادات بوت الموسيقى - ضع بياناتك هنا
//           افتح هذا الملف بأي محرر نصي وعدّل القيم
// ============================================================

module.exports = {
    // ─── TOKEN LIST: first token is the main bot ─────────────
    // Choose ONE: TOKEN_LIST below, BOT_TOKENS JSON environment, or tokens.txt.
    // One token works too. Do not publish real tokens.
    TOKEN_LIST: [],
    FLEET_MAX_BOTS: 100,                 // configurable upward if resources permit
    OWNER_IDS: [],                       // additional permanent root owner IDs
    STORAGE_BACKEND: "sqlite",            // indexed shared WAL database + async worker
    DATA_DIR: "",                         // empty = ./data; optional absolute persistent directory
    FLEET_LOGIN_DELAY_MS: 1500,
    FLEET_LOGIN_CONCURRENCY: 4,
    FLEET_LOGIN_RETRY_BASE_MS: 2000,
    FLEET_LOGIN_RETRY_MAX_MS: 60000,
    FLEET_JOIN_DELAY_MS: 300,
    FLEET_RESTORE_RETRY_BASE_MS: 2000,
    FLEET_RESTORE_RETRY_MAX_MS: 60000,
    FLEET_SHUTDOWN_TIMEOUT_MS: 30000,
    FLEET_MESSAGE_CACHE: 16,
    FLEET_MEMBER_CACHE: 128,
    FLEET_USER_CACHE: 512,
    FLEET_COMMAND_COOLDOWN_MS: 400,
    FLEET_QUIET_ERRORS: true,
    FLEET_AUDIO_THRESHOLD: 8,             // high-concurrency native encoding in FFmpeg
    FLEET_AUDIO_PIPELINE_MODE: "ffmpeg-opus", // same OPUS_BITRATE; empty string keeps AUDIO_PIPELINE_MODE
    YTDLP_METADATA_CONCURRENCY: 8,
    YTDLP_METADATA_QUEUE_MAX: 500,


    // ─── بيانات البوت الأساسية (إلزامية) ───────────────────
    CLIENT_ID: "",      // Application ID من صفحة البوت في Discord Developer Portal
    GUILD_ID: "",                          // ايدي السيرفر الرئيسي (اختياري - للتجربة السريعة)

    // ─── إعدادات المالك ──────────────────────────────────────
    OWNER_ID: "",       // ايدي حسابك في ديسكورد (كليك يمين على اسمك → نسخ المعرف)
    OWNER_TAG: "",              // اسمك في ديسكورد (للعرض فقط)

    // ─── البريفكس ────────────────────────────────────────────
    PREFIX: "-",                           // البريفكس الافتراضي (يمكن تغييره من ديسكورد بأمر -بريفكس)

    // ─── توافق قديم: نظام Fleet يتجاهل القفل؛ الأونر يوزع البوتات بالأوامر ──
    VOICE_CHANNEL_LOCK: "",              // ايدي القناة الصوتية المخصصة للبوت (اتركها "" للسماح بكل القنوات)
    TEXT_CHANNEL_LOCK: "",               // ايدي القناة النصية المخصصة للبوت (اتركها "" للسماح بكل القنوات)

    // ─── السيرفرات المسموح بها (اتركها [] للسماح بالكل) ─────
    ALLOWED_GUILD_IDS: [],               // مثال: ["YOUR_DISCORD_ID", "YOUR_DISCORD_ID"]

    // ─── ملف الأداء: تلقائي حسب المعالج مع أولوية قصوى للصوت ──────
    PERFORMANCE_PROFILE: "auto-high-performance",
    PERFORMANCE_LOGICAL_THREADS: 0,       // 0 = اكتشاف كل الأنوية/المسارات تلقائياً؛ لا سقف 6 threads على الأجهزة الأقوى
    PERFORMANCE_RESERVED_THREADS: 1,      // نترك coordinator واحداً للـEvent Loop وDiscord/Windows حتى لا يقطع الصوت
    PERFORMANCE_HEAVY_THREADS: 0,         // 0 = استخدم تلقائياً كل المتاح ناقص المحجوز، ثم اخفض الخلفية أثناء الصوت
    PERFORMANCE_AUDIO_THREADS: 6,         // stream حي واحد يحتاج عادةً 1-2 codec threads؛ الباقي يبقى للـevent loop/prefetch
    PERFORMANCE_SHARP_THREADS: 0,         // 0 = تلقائي حسب CPU؛ يتقلص فوراً عندما يكون الصوت حياً
    PERFORMANCE_UV_THREADS: 0,            // 0 = تلقائي (>=8 وحتى 32) حسب عدد logical CPUs
    PERFORMANCE_SHARP_CACHE_MB: 512,      // استغلال RAM أقوى كـimage cache مع بقاء مساحة كافية لويندوز والصوت
    PERFORMANCE_HEAVY_JOB_CONCURRENCY: 2, // رندر ثقيل واحد في كل مرة؛ يستخدم 5 threads بدل تكديس عدة FFmpeg
    PERFORMANCE_NODE_HEAP_MB: 0,       // start.bat يشغّل Node بحد heap 7GB على جهاز 16GB
    PERFORMANCE_ABOVE_NORMAL_PRIORITY: true,
    PERFORMANCE_PREFETCH_NEXT_TRACKS: 2,  // تجهيز التراك التالي بالخلفية ضمن حدود العمل المشترك

    // ─── إعدادات الموسيقى ────────────────────────────────────
    DEFAULT_VOLUME: 90,                  // صوت قوي وواضح بدون تضخيم مبالغ؛ لا ترفع فوق 100 إذا ظهر تغبيش
    MAX_VOLUME: 150,                     // أعلى من 100 قد يسبب تشويش؛ اتركه 150 كحد آمن
    SEEK_SECONDS: 20,                    // ثواني التقديم/الرجوع عند الضغط على الأزرار أو الأوامر
    MAX_QUEUE_SIZE: 1000,                // يسمح بقوائم كبيرة وتشغيل مفضلات ضخمة بدون قطعها عند 100
    PLAY_COMMAND_REPLACES_CURRENT: false, // أمر ش أثناء تشغيل أغنية يضيف للقائمة. استخدم ش_الان للتشغيل الفوري

    // ─── إعدادات الغياب عن القناة ───────────────────────────
    LEAVE_ON_EMPTY: false,               // مهم: false = البوت يبقى مثبتاً في الروم حتى لو صار فارغاً
    LEAVE_TIMEOUT: 60000,               // وقت الانتظار قبل المغادرة بالمللي ثانية (60000 = دقيقة)
    AUTO_PAUSE_ON_EMPTY: false,          // لا توقف تلقائي بسبب إخلاء الروم



    // ─── تثبيت البوت في الروم الصوتي ───────────────────────
    STAY_IN_VOICE: true,                // البوت لا يغادر الروم عند وقف الموسيقى أو فراغ الروم
    AUTO_REJOIN_ON_DISCONNECT: true,    // إذا تم فصله يجرّب الرجوع لنفس الروم تلقائياً
    REJOIN_DELAY: 1500,                 // أول محاولة رجوع سريعة
    REJOIN_MAX_DELAY: 30000,            // Backoff حتى 30s عند انقطاع طويل؛ يمنع spam مع بقاء المحاولات لا نهائية
    REJOIN_MAX_TRIES: 0,                // 0 = محاولات لا نهائية

    // ─── جودة الصوت ──────────────────────────────────────────
    AUDIO_QUALITY: "ultra",             // جودة الصوت: low / medium / high / ultra
    YTDLP_AUDIO_FORMAT: "bestaudio/best", // أعلى مصدر صوت متاح من الموقع؛ لا نفرض Opus منخفض الجودة على مصدر أفضل
    // ─── تحسينات HQ/Stability ────────────────────────────────
    AUDIO_PIPELINE_MODE: "hq-opus",      // PCM من FFmpeg ثم تحكم صوت مباشر وترميز Opus عالي الجودة دون إعادة تشغيل الأغنية
    PCM_PRE_GAIN: 0.92,                    // خفض داخلي قبل inlineVolume لمنع تشوه البيس/clipping مع الحفاظ على مستوى 90% نظيف
    PCM_LIMIT_INLINE_GAIN: true,           // يمنع تضخيم inlineVolume فوق 1.0 في مسار PCM حتى لا يتكسر البيس
    AUDIO_PIPELINE_FALLBACK: false,      // لا تخفض الجودة تلقائياً إلى PCM/128k؛ يمكن تفعيله يدوياً إذا تعذر مرمّز Opus
    OPUS_BITRATE: 384000,                // هدف Opus؛ يضبط عبر opus encoder CTL مباشرة لتجاوز حد Prism البالغ 128k
    PCM_OPUS_BITRATE: 128000,             // لمسار PCM الاختياري فقط؛ Prism يحده إلى 128k ولا يستخدم افتراضياً
    OPUS_FRAME_SIZE: 960,                // 20ms @ 48kHz؛ أفضل توازن للثبات والتأخير
    HQ_OPUS_LIVE_VOLUME: true,           // جودة أعلى مع تحكم صوت مباشر عبر VolumeTransformer قبل ترميز Opus
    HQ_OPUS_LIMIT_GAIN: true,             // يمنع clipping عند البيس؛ فوق 100% لا يضخم الموجة داخل المسار عالي الجودة
    HQ_OPUS_PRE_GAIN: 1.0,               // 100% يمر دون تخفيض؛ نحد التضخيم فوق 100% لمنع clipping
    AUDIO_STARTUP_BUFFER_MS: 700,          // real Opus packets; protects startup against short source jitter
    AUDIO_PIPELINE_READY_TIMEOUT_MS: 22000, // أقصى انتظار لأول عينة صوت حقيقية قبل اعتبار المصدر فاشلاً
    PLAYING_STABILITY_GRACE_MS: 600,        // لا يعلن التشغيل ناجحاً إلا إذا صمد الصوت فعلاً
    PLAYBACK_RETRIES: 4,                 // محاولات إعادة التشغيل عند فشل البداية؛ بدون جنون تخطي مستمر
    PLAYBACK_RETRY_DELAY: 1200,          // وقت الانتظار بين محاولات التشغيل
    STREAM_ERROR_RETRIES: 3,             // محاولة استعادة نفس الأغنية عند خطأ صوت أثناء التشغيل قبل الإيقاف الآمن
    EARLY_IDLE_RETRIES: 3,                 // حماية من انتهاء وهمي خلال أول ثواني من التشغيل
    EARLY_IDLE_WINDOW_MS: 9000,            // إذا صار Idle قبل هذا الوقت فهو فشل stream غالباً وليس انتهاء طبيعي
    VOICE_HEALTH_CHECK_INTERVAL: 30000,   // فحص دوري للاتصال الصوتي والبقاء في الروم
    STREAM_HIGH_WATER_MARK: 67108864,   // 32 MiB bounded buffer لكل مسار؛ القيمة كما ضبطها المستخدم
    FFMPEG_PATH: "",                    // اختياري: اتركه فارغاً لاختيار أفضل FFmpeg متاح تلقائياً
    FFMPEG_THREADS: 0,                   // fallback فقط؛ profile الأداء يحدد audio/heavy threads بشكل منفصل
    FFMPEG_AUDIO_FILTER: "aresample=48000:async=1:first_pts=0", // تحويل 44.1k إلى 48k مع مزامنة ثابتة؛ متوافق مع FFmpeg على Windows دون اعتماد SoXR
    PROGRESS_UPDATE_INTERVAL: 5000,      // فحص وقت البطاقة كل ثانية؛ التحديث داخل نفس الإمبيد بدون إعادة رفع الصورة
    AUDIO_CACHE_CONCURRENCY: 6,          // عند الخمول؛ أثناء صوت حي ينخفض prefetch تلقائياً إلى تنزيل خلفي واحد
    AUDIO_CACHE_QUEUE_MAX: 24,           // يمنع تراكم تنزيلات قديمة عند skip/jump سريع
    LYRICS_AUTO_UPDATE_MS: 125,              // Discord Auto-Follow checks 8x/s; edits still happen only when the active lyric line changes
    LYRICS_AUTO_SESSION_MAX_MS: 21600000, // 6h: Auto lyrics يبقى فعالاً عبر انتقال الأغاني، ويتوقف فقط عند إغلاق الجلسة/الخمول الطويل
    LYRICS_AUTO_RESOLVE_RETRY_MS: 12000,
    LYRICS_AUTO_MAX_SESSIONS: 1024,       // حد صريح لجلسات التتبع لمنع تراكم timers عند الاستخدام الكبير   // إذا وجد نصاً فقط/لم يجد كلمات، يعيد البحث عن synced lyrics تلقائياً بدون إعادة فتح اللوحة
    DISCORD_LYRICS_SYNC_OFFSET_MS: 0,  // baseline adaptive lead against Discord REST latency
    LYRICS_DISCORD_MIN_EDIT_GAP_MS: 140, // protects Discord rate limits without slowing normal line-by-line sync  // baseline فقط؛ Auto يرفع التعويض تلقائياً حسب latency الحقيقي لتعديل Discord (بدون 1.5s ثابتة)
    LYRICS_DISCORD_MAX_LATENCY_LEAD_MS: 200, // cap REST prediction; slow requests must not jump to future vocals
    WEB_LYRICS_SYNC_OFFSET_MS: -250,       // يعوّض زمن وصول الصوت الفعلي من Discord بدلاً من تقديم الكلمات
    LYRICS_AUDIO_PRESENTATION_LATENCY_MS: 250, // تقدير presentation/buffer latency للصوت؛ Discord Auto يطرحه من REST latency
       // واجهة الويب تتبع التوقيت محلياً؛ لا تقديم افتراضي، ويبقى Fine Tune اليدوي متاحاً
    LYRICS_HTTP_CONCURRENCY: 12,          // توازي عالمي متزن: سريع بدون دفع مزودي الكلمات نحو 429 تحت الضغط
    LYRICS_YOUTUBE_PROBE_CONCURRENCY: 8, // يفحص عدة نسخ Lyrics/Remix بالتوازي عند غياب توقيت دقيق
    LYRICS_YTDLP_CONCURRENCY: 0,          // 0 = auto حسب عدد الأنوية؛ يحد عمليات yt-dlp الخاصة بالكلمات حتى لا تزاحم الصوت الحي
    LYRICS_KARALYR_ENABLED: true,          // مصدر synced إضافي no-key بعد LRCLIB لزيادة التغطية بدون إبطاء المسار الشائع
    LYRICS_KARALYR_QUERY_LIMIT: 8,         // exact/search variants محدودة لتجنب ضغط غير ضروري
    LYRICS_KARALYR_CONCURRENCY: 4,         // أقل من LRCLIB لأن المصدر fallback وليس المسار الرئيسي
    LYRICS_KARALYR_MISS_TTL_MS: 1800000, // 30 دقيقة؛ المصدر نفسه يوضح أن إعادة miss فوراً لا تضيف شيئاً
    LYRICS_LRCMUX_ENABLED: true,           // مجمّع synced no-key عبر عدة مزودين؛ fallback واحد بدل scrapers كثيرة
    LYRICS_LRCMUX_QUERY_LIMIT: 2,          // طلبان متوازيان كحد أقصى حتى لا يضيف fallback أكثر من مهلة شبكة واحدة تقريباً
    LYRICS_LRCMUX_CONCURRENCY: 2,          // يحافظ على السرعة بدون مزاحمة LRCLIB/الصوت
    LYRICS_LRCMUX_MISS_TTL_MS: 1200000,   // 20 دقيقة لتخفيف الضغط عند عدم وجود كلمات لدى أي مزود داخل المجمّع
    LYRICS_METADATA_TIMEOUT_MS: 12000,    // وقت كافٍ لاستخراج metadata الحقيقي للفيديو/الريمكس عبر yt-dlp
    LYRICS_DEEP_QUERY_LIMIT: 28,          // عدد استعلامات البحث العميق قبل الانتقال للـfallback
    LYRICS_CAPTION_CANDIDATE_LIMIT: 32,   // يفحص لغات وصيغ Captions أكثر قبل إعلان عدم وجود كلمات
    LYRICS_YOUTUBE_SKIP_TRANSLATED_CAPTIONS: true, // لا نحمّل auto-translations من YouTube؛ نستخدم الأصل/الـRomanization الحقيقي فقط
    LYRICS_ANY_LANGUAGE_FALLBACK: true,   // only for languages without a strict policy below   // لغير العربي: يسمح بالـRomaji/لغة بديلة عند الحاجة. العربي له فلتر مستقل أدناه.
    LYRICS_ARABIC_STRICT: true,            // Arabic track => visible lyric body must actually be Arabic
    LYRICS_ENGLISH_STRICT: true,           // English track => reject explicitly foreign captions / strongly non-English Latin text
    LYRICS_CJK_ROMANIZATION_PREFERRED: true, // Japanese/Korean/Chinese prefer readable Romaji/Romanization/Pinyin; native script is fallback            // الأغنية العربية لا تعرض Turkish/Latin auto-captions كنص كلمات حتى لو كانت timestamps جيدة
    LYRICS_ARABIC_DESCRIPTION_FALLBACK: true, // استخرج نصاً عربياً من وصف النسخة الرسمية عند غياب قواعد البيانات
    LYRICS_ARABIC_ADAPTIVE_TIMING: true,   // يستخدم timestamps فقط من captions الرديئة كهيكل توقيت، مع إبقاء النص العربي الصحيح
    LYRICS_ARABIC_YOUTUBE_DEEP_SEARCH: true, // بحث أعمق عن نسخة مطابقة تحمل كلمات عربية في الوصف (يفيد SoundCloud/Spotify/TIDAL)
    LYRICS_ARABIC_YOUTUBE_CANDIDATE_LIMIT: 10,
    LYRICS_EXACT_TIMING_CALIBRATION: true, // معايرة timestamps من نفس فيديو YouTube عند توفر timing skeleton موثوق
    LYRICS_PLAIN_TIMING_FALLBACK: true,    // لا تترك Full Text ثابتاً: ابنِ sync من captions أو تقدير موزون كحل أخير
    LYRICS_ESTIMATED_INTRO_SEC: 4.5,       // fallback فقط عند عدم وجود أي timing حقيقي
    LYRICS_ESTIMATED_OUTRO_SEC: 5.0,
    LYRICS_CJK_DESCRIPTION_ROMANIZATION: true, // ابحث عن Romaji/Pinyin/Romanized body ثم اربطه بتوقيت النسخة الأصلية
    LYRICS_EMPTY_CACHE_TTL_MS: 45000,      // نتيجة عدم العثور مؤقتة فقط؛ أعد المحاولة سريعاً إذا عاد المصدر
    LYRICS_METADATA_MISS_TTL_MS: 60000,    // فشل metadata المؤقت لا يحبس الأغنية 30 دقيقة بلا بحث عميق

    // ─── محرك يوتيوب الجديد yt-dlp ───────────────────────────
    // اترك YTDLP_PATH فارغاً غالباً. install.bat يحاول تثبيت yt-dlp تلقائياً عبر Python/pip أو تحميله في مجلد bin.
    YTDLP_PATH: "",                      // اختياري: مسار yt-dlp.exe إذا ثبته يدوياً
    YTDLP_SEARCH_LIMIT: 5,               // عدد نتائج البحث العام. أمر ش يستخدم أفضل نتيجة بسرعة
    YTDLP_PLAYLIST_LIMIT: 100,           // أقصى عدد أغاني من البلايليست؛ لن يتخطاها بجنون عند فشل أغنية
    YTDLP_METADATA_TIMEOUT: 30000,       // مهلة جلب معلومات الأغنية/البحث بالمللي ثانية
    SOURCE_LINK_RESOLVE_TIMEOUT_MS: 5000, // فك روابط المشاركة المختصرة و metadata لـ Spotify/TIDAL بدون لمس محرك الصوت
    SOUNDCLOUD_METADATA_TIMEOUT_MS: 35000,// SoundCloud قد يحتاج وقتاً أطول قليلاً لجلب playlist metadata
    SOUNDCLOUD_PLAYLIST_DEEP_FALLBACK: true, // إذا أعطى flat-playlist عناصر ناقصة نعيد الاستخراج الكامل تلقائياً
    SOUNDCLOUD_PLAYLIST_DEEP_TIMEOUT_MS: 60000,
    YTDLP_USER_AGENT: "",               // اختياري: User-Agent مخصص
    YTDLP_COOKIES_PATH: "",             // اختياري: مسار cookies.txt إذا واجهت YouTube bot-check
    YTDLP_COOKIES_FROM_BROWSER: "",     // اختياري: مثال "chrome" أو "firefox" إذا كان yt-dlp يدعم قراءة كوكيز المتصفح
    YTDLP_SOCKET_TIMEOUT: 25,            // مهلة الشبكة لليوتيوب
    YTDLP_RETRIES: "infinite",          // إعادة المحاولة عند مشاكل الشبكة
    YTDLP_FRAGMENT_RETRIES: "infinite", // إعادة محاولة أجزاء الصوت
    YTDLP_CONCURRENT_FRAGMENTS: 4,      // تحميل متوازي قوي مثل محرك الكنترول
    YTDLP_UPDATE_CHANNEL: "nightly",     // أحدث إصلاحات YouTube/403 قبل stable عند الحاجة
    YTDLP_DOWNLOAD_PLAYER_CLIENTS: ["default", "android", "web_embedded", "ios", "mweb", "web_safari"], // تدوير clients للتنزيل؛ Android مبكرًا لأنه بديل مهم عند 403/SABR، ثم بقية المسارات
    YTDLP_THROTTLED_RATE: "100K",        // يعيد استخراج الرابط عند throttling ولا يضع سقف سرعة
    YTDLP_DOWNLOAD_STRATEGY_RETRIES: 2,  // لكل client نحاول مرتين قبل الانتقال للخطة التالية عند فشل/403
    // تشغيل الصوت يدور بين مسارات YouTube مختلفة بدل إعادة نفس الطلب الفاشل خمس مرات.
    YTDLP_PLAYBACK_CLIENT_STRATEGIES: [
        ["android", "web_embedded", "web_safari", "web", "ios"],
        ["web_safari", "ios", "web_embedded"],
        ["android", "mweb"],
        ["web", "web_embedded"],
        ["ios", "mweb", "web_safari"],
    ],
    YTDLP_PLAYBACK_RETRIES_PER_STRATEGY: 3,
    YTDLP_PLAYBACK_FRAGMENT_RETRIES: 5,
    YTDLP_PLAYBACK_EXTRACTOR_RETRIES: 3,
    YTDLP_PLAYBACK_SOCKET_TIMEOUT: 18,
    YTDLP_PLAYBACK_SOURCE_READY_TIMEOUT_MS: 18000, // لا نشغل FFmpeg قبل وصول bytes صوت حقيقية من yt-dlp
    SOURCE_RESOLUTION_TIMEOUT_MS: 45000,        // shared deadline across catalog search variants
    DIRECT_AUDIO_FETCH_TIMEOUT_MS: 20000,         // الروابط المباشرة لا يسمح لها بتعليق طلب تشغيل للأبد

    // ─── نظام القائمة الاحترافي ─────────────────────────────
    QUEUE_PAGE_SIZE: 8,                 // عدد الأغاني في صفحة القائمة
    SHOW_UP_NEXT_IN_NOW_PLAYING: false, // الواجهة الرئيسية Compact؛ التفاصيل تظهر من زر القائمة
    QUEUE_ADD_NOTIFICATION: true,       // رسالة مختصرة عند إضافة أغنية للقائمة
    QUEUE_KEEP_HISTORY_AFTER_END: false,// false = يمسح القائمة بعد الانتهاء لتوفير الرام
    AUTO_SKIP_FAILED_TRACKS: false,       // مهم: لا يتخطى البلايليست بجنون إذا فشل stream؛ يوقف عند المشكلة بدل إنهاء 100 أغنية
    PLAY_NOW_ALIASES_ENABLED: true,     // أوامر ش_الان/فوري لتجاوز القائمة وتشغيل فوري

    // ─── نظام المفضلة الخاصة لكل عضو ────────────────────────
    FAVORITES_ENABLED: true,            // تخزين مستقل لكل عضو داخل data/favorites/ ليتوسع لآلاف المستخدمين
    FAVORITES_MAX_PER_USER: 0,          // 0 = unlimited durable favorites
    HISTORY_MAX_TRACKS: 0,              // 0 = retain every distinct history track
    PLAYLISTS_MAX_PER_USER: 0,           // 0 = no playlist-count quota
    PLAYLIST_MAX_TRACKS: 0,              // 0 = no durable playlist-size quota
    PLATFORM_COLLECTION_MAX_ITEMS: 0,   // 0 = no saved album/artist/download quota
    PLATFORM_FEEDBACK_MAX_ITEMS: 0,     // 0 = retain all taste feedback
    PLATFORM_HISTORY_MAX_EVENTS: 0,     // 0 = keep listening events indefinitely
    PLATFORM_INTERACTION_MAX_EVENTS: 0, // 0 = retain all per-user search/detail signals
    FAVORITES_PAGE_SIZE: 25,            // Discord يسمح حتى 25 خياراً بالقائمة؛ صفحات إضافية تلقائياً
    FAVORITES_CACHE_USERS: 256,         // LRU للملفات النشطة فقط لمنع نمو الرام مع آلاف المستخدمين
    FAVORITES_SAVE_DEBOUNCE_MS: 200,    // تجميع تغييرات سريعة ثم حفظ ذري لكل مستخدم
    FAVORITES_PRIVATE_MODE: true,       // عرض المفضلة عبر رسائل مخفية فقط قدر الإمكان

    // ─── واجهة المشغل المصغرة ─────────────────────────────────
    NOW_PLAYING_STYLE: "glass",          // واجهة زجاجية حديثة أقرب لتايدال/داينمك آيلاند
    NOW_PLAYING_ANIMATION: true,           // تحديث الواجهة وشريط التقدم كل ثانية
    NOW_PLAYING_DYNAMIC_CARD: true,        // بطاقة احترافية بخلفية ألوان ضبابية مشتقة من الغلاف بدون تمديد صورة الغلاف
    NOW_PLAYING_CARD_WIDTH: 1040,          // Compact glass player suitable for desktop/mobile Discord
    NOW_PLAYING_CARD_HEIGHT: 420,          // Low-profile Tidal-like layout
    NOW_PLAYING_ANIMATED_BACKGROUND: true, // 60fps color-field loop derived from cover colors; cover image itself is not used as the background
    NOW_PLAYING_ANIMATION_FPS: 60,         // Source animation is rendered at 60fps; client playback cadence is controlled by Discord
    NOW_PLAYING_ANIMATION_SECONDS: 2,      // Seamless short loop; keeps upload size practical
    NOW_PLAYING_ANIMATION_WIDTH: 960,        // animated WebP at player width, GIF fallback
    NOW_PLAYING_ANIMATION_MAX_BYTES: 18500000, // under Discord's usual 20 MiB file limit; static fallback if larger
    NOW_PLAYING_ANIMATION_CACHE_MB: 512,      // حد رام للكاش المتحرك؛ يمنع تراكم مئات الميغابايت/الجيجابايت مع التشغيل الطويل
    NOW_PLAYING_IMAGE_CACHE_MB: 512,          // حد رام لأغلفة المصدر الخام قبل المعالجة؛ جودة كاملة مع حد صريح للاستقرار
    NOW_PLAYING_NEXT_PREVIEW: 1,           // إظهار التالي فقط عند وجوده
    NOW_PLAYING_BAR_SIZE: 30,              // شريط احتياطي نصي عند تعذر البطاقة
    LYRICS_DYNAMIC_CARD: true,             // بطاقة كلمات احترافية للكلمات المتزامنة

    // ─── واجهة الويب العالمية الاحترافية ────────────────────
    WEB_PLAYER_ENABLED: true,
    WEB_PLAYER_HOST: "127.0.0.1",        // origin محلي فقط؛ Cloudflare Tunnel ينشره للعالم بدون فتح Port في الراوتر
    WEB_PLAYER_PORT: 3780,
    WEB_PLAYER_GLOBAL_ACCESS: true,       // تشغيل HTTPS عالمي تلقائياً
    WEB_PLAYER_REQUIRE_GLOBAL_HTTPS: true,// لا يرسل روابط LAN غير آمنة إذا فشل النفق العالمي
    WEB_PLAYER_GLOBAL_MODE: "auto",      // auto = Named Tunnel إذا وُجد token، وإلا Quick Tunnel HTTPS تلقائي
    WEB_PLAYER_QUICK_TUNNEL: true,        // يعمل فوراً بلا حساب/دومين؛ الرابط يتغير عند إعادة إنشاء النفق
    WEB_PLAYER_PUBLIC_URL: "",           // للدومين الثابت فقط: مثال https://music.example.com
    WEB_PLAYER_TRUST_PROXY: true,         // آمن مع 127.0.0.1؛ يثق بـ X-Forwarded-Proto القادم من cloudflared
    WEB_PLAYER_FORCE_PUBLIC_HTTPS: true,  // يمنع أي رابط خارجي HTTP عند وجود Public HTTPS
    CLOUDFLARE_TUNNEL_TOKEN: "",         // اختياري للدومين الثابت؛ الأفضل تمريره كمتغير بيئة وليس نشره داخل السورس
    CLOUDFLARED_PATH: "",               // اختياري؛ إذا فارغ يبحث محلياً ثم ينزّل نسخة موثقة تلقائياً
    CLOUDFLARED_AUTO_DOWNLOAD: true,      // تنزيل cloudflared الرسمي والتحقق SHA-256 تلقائياً عند الحاجة
    CLOUDFLARED_VERSION: "2026.9.3",     // إصدار مثبت ومتحقق لمنع تشغيل Binary غير متوقع
    CLOUDFLARE_TUNNEL_START_TIMEOUT_MS: 45000,
    CLOUDFLARE_TUNNEL_BOOT_RETRIES: 4,      // إعادة محاولة بدء النفق عند انقطاع الشبكة المؤقت وقت تشغيل البوت
    CLOUDFLARE_TUNNEL_RETRY_BASE_MS: 1500,  // Backoff تصاعدي لأول اتصال عالمي
    CLOUDFLARE_TUNNEL_PROTOCOL: "auto",      // يبدأ QUIC تلقائياً حسب cloudflared ثم يمكن الانتقال إلى HTTP/2
    CLOUDFLARE_HTTP2_FALLBACK: true,          // دفاع إضافي للشبكات/شركات الاتصال التي ترفض QUIC بشكل غير معتاد
    WEB_PLAYER_HTTPS_KEY_PATH: "",        // اختياري فقط عند تقديم HTTPS مباشرة بدون Cloudflare Tunnel
    WEB_PLAYER_HTTPS_CERT_PATH: "",       // Cloudflare Tunnel لا يحتاج شهادة PEM محلية
    WEB_PLAYER_HTTPS_CA_PATH: "",
    WEB_PLAYER_SECRET: "",               // يترك فارغاً ليُنشئ مفتاح HMAC محلي آمن داخل data/
    WEB_PLAYER_SESSION_TTL_MS: 43200000,  // 12 ساعة للرابط الخاص

    // ─── جودة غلاف الأغنية في Web Player ─────────────────────
    ARTWORK_PROVIDER_TIMEOUT_MS: 3400,    // مهلة قصيرة لكل طلب؛ البحث نفسه متوازي ولا يوقف الصوت
    ARTWORK_METADATA_TIMEOUT_MS: 7000,    // yt-dlp metadata pass لاستخراج اسم التراك/الألبوم الحقيقي عند الحاجة
    ARTWORK_HTTP_CONCURRENCY: 48,         // توازي قوي لطلبات Apple/Deezer؛ MusicBrainz يبقى ملتزماً بحده الرسمي
    ARTWORK_APPLE_STOREFRONTS: ["US", "GB", "JP", "KR", "CN", "AE", "SA", "KW", "EG", "DE", "FR", "AU"], // 12 storefronts: global + Japan/Korea/China + Gulf/Arabic coverage; deep lookup only after the fast pass
    ARTWORK_OFFICIAL_CHAIN_MAX: 14,        // عدد الأغلفة الرسمية المحتفظ بها قبل fallback يوتيوب
    ARTWORK_YTDLP_METADATA: true,
    ARTWORK_VALIDATE_OFFICIAL: true,       // يتحقق من روابط الأغلفة الرسمية قبل إرسالها للويب حتى لا نسقط إلى YouTube بسبب رابط 404         // استخراج track/artist/album الحقيقي في الخلفية إذا كانت بيانات YouTube ناقصة
    ARTWORK_CACHE_TTL_MS: 21600000,       // 6 ساعات للنتائج الرسمية
    ARTWORK_MISS_CACHE_TTL_MS: 120000,    // الفشل المؤقت لا يثبت fallback لوقت طويل
    ARTWORK_BACKGROUND_RETRY_MS: 60000,   // أثناء عرض fallback يعيد البحث الرسمي بالخلفية كل دقيقة حتى يجد غلافاً موثوقاً
    ARTWORK_CACHE_MAX: 1400,               // LRU محدود للثبات مع التشغيل الطويل
    ARTWORK_ANIMATED_ENABLED: true,      // Apple Music Album Motion / animated cover video when an exact official album match exists
    ARTWORK_ANIMATED_APPLE_ENABLED: true,
    ARTWORK_ANIMATED_MUSICHOARDERS_ENABLED: false, // The provider's internal API requires authorization; verified Apple release motion is used.
    ARTWORK_ANIMATED_TIMEOUT_MS: 9000,
    ARTWORK_ANIMATED_CACHE_TTL_MS: 43200000, // 12h; motion metadata is stable and videos are CDN-hosted
    ARTWORK_ANIMATED_MISS_TTL_MS: 900000,   // retry misses later; providers can add motion art over time
    ARTWORK_ANIMATED_MAX_CANDIDATES: 6,
    ARTWORK_STATIC_APPLE_SIZE: 3000,         // true source request; never fake-upscale beyond provider capability

    // ─── مصادر الموسيقى المفعّلة ─────────────────────────────
    SOURCES: {
        YOUTUBE: true,                  // يوتيوب عبر yt-dlp (المصدر الرئيسي)
        SOUNDCLOUD: true,               // Track + playlist/set + روابط المشاركة؛ التشغيل يمر عبر yt-dlp نفسه
        SPOTIFY: true,                  // رابط Track -> metadata رسمي -> أفضل نتيجة عبر المصدر الرئيسي، لا بث مباشر من Spotify
        TIDAL: true,                    // رابط Track -> metadata/oEmbed -> أفضل نتيجة عبر المصدر الرئيسي، لا بث مباشر من TIDAL
        DIRECT_LINK: true,              // روابط مباشرة (mp3, m4a, ogg, wav...)
    },

    // ─── الألوان (يمكن تغييرها) ──────────────────────────────
    COLORS: {
        PRIMARY: "#7C8CFF",             // هادئ وحديث
        SUCCESS: "#62D5A8",             // نجاح
        ERROR: "#FF5D73",               // خطأ
        WARNING: "#F8D66D",             // تحذير
        INFO: "#7C8CFF",                // معلومات
        MUSIC: "#8FA8FF",               // أساس الواجهة عند غياب ألوان صورة الأغنية
    },

    // ─── رسائل النظام ────────────────────────────────────────
    MESSAGES: {
        NO_VOICE_CHANNEL: "🔇 يجب أن تكون في قناة صوتية أولاً!",
        NO_MUSIC: "🎵 لا توجد موسيقى تعزف حالياً!",
        NO_PERMISSION: "🚫 ليس لديك صلاحية لاستخدام هذا الأمر!",
        BOT_NO_PERMISSION: "🚫 البوت ليس لديه صلاحية للانضمام لقناتك الصوتية!",
        QUEUE_EMPTY: "📋 قائمة التشغيل فارغة!",
        OWNER_ONLY: "👑 هذا الأمر للمالك فقط!",
        WRONG_CHANNEL: "⛔ البوت مقيد بقناة صوتية محددة في هذا السيرفر!",
    }

};
