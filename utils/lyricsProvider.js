const crypto = require('crypto');
const os = require('node:os');
const config = require('../config');

const CACHE_TTL_MS = 1000 * 60 * 60 * 12;
// لا نخزن نتيجة "لم أجد كلمات" لمدة طويلة؛ قد تكون المشكلة مؤقتة في مصدر الكلمات.
const EMPTY_CACHE_TTL_MS = Math.max(15000, Number(config.LYRICS_EMPTY_CACHE_TTL_MS || 45000));
const cache = new Map();
const CACHE_MAX_ENTRIES = 500;
const CACHE_SWEEP_MS = 1000 * 60 * 10;
const LYRICS_HTTP_CONCURRENCY = Math.max(3, Math.min(20, Number(config.LYRICS_HTTP_CONCURRENCY || Math.max(8, os.availableParallelism?.() || os.cpus().length || 8))));
const LYRICS_YOUTUBE_PROBE_CONCURRENCY = Math.max(1, Math.min(8, Number(config.LYRICS_YOUTUBE_PROBE_CONCURRENCY || 4)));
const detectedThreads = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
const LYRICS_YTDLP_CONCURRENCY = Math.max(2, Math.min(8, Number(config.LYRICS_YTDLP_CONCURRENCY || Math.min(6, Math.floor(detectedThreads / 2) + 1))));
const LYRICS_METADATA_TIMEOUT_MS = Math.max(4000, Math.min(20000, Number(config.LYRICS_METADATA_TIMEOUT_MS || 10000)));
const LYRICS_DEEP_QUERY_LIMIT = Math.max(4, Math.min(28, Number(config.LYRICS_DEEP_QUERY_LIMIT || 18)));
const LYRICS_CAPTION_CANDIDATE_LIMIT = Math.max(8, Math.min(40, Number(config.LYRICS_CAPTION_CANDIDATE_LIMIT || 28)));
const LYRICS_ANY_LANGUAGE_FALLBACK = config.LYRICS_ANY_LANGUAGE_FALLBACK !== false;
const METADATA_CACHE_TTL_MS = 30 * 60_000;
const METADATA_MISS_TTL_MS = Math.max(15000, Number(config.LYRICS_METADATA_MISS_TTL_MS || 60000));
const metadataCache = new Map();


function cacheSet(key, value) {
    const now = Date.now();
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { at: now, value });
    while (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function sweepLyricsCache() {
    const now = Date.now();
    for (const [key, entry] of cache) {
        const isEmpty = !entry?.value?.plainLyrics && !(entry?.value?.syncedLines || []).length;
        const ttl = isEmpty ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS;
        if (!entry || now - Number(entry.at || 0) >= ttl) cache.delete(key);
    }
}

const cacheSweepTimer = setInterval(sweepLyricsCache, CACHE_SWEEP_MS);
cacheSweepTimer.unref?.();

function hashKey(input) {
    return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 16);
}

function normalizeSpaces(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function hasArabic(text = '') {
    return /[؀-ۿ]/.test(String(text || ''));
}

function hasLatin(text = '') {
    return /[A-Za-z]/.test(String(text || ''));
}

function scriptProfile(text = '') {
    const value = String(text || '');
    const counts = {
        arabic: (value.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/gu) || []).length,
        latin: (value.match(/[A-Za-z\u00C0-\u024F]/gu) || []).length,
        kana: (value.match(/[\u3040-\u30FF]/gu) || []).length,
        han: (value.match(/[\u3400-\u9FFF]/gu) || []).length,
        hangul: (value.match(/[\uAC00-\uD7AF]/gu) || []).length,
        cyrillic: (value.match(/[\u0400-\u04FF]/gu) || []).length,
        devanagari: (value.match(/[\u0900-\u097F]/gu) || []).length,
    };
    counts.letters = Object.values(counts).reduce((a, b) => a + b, 0);
    counts.arabicRatio = counts.letters ? counts.arabic / counts.letters : 0;
    counts.latinRatio = counts.letters ? counts.latin / counts.letters : 0;
    counts.cjkRatio = counts.letters ? (counts.kana + counts.han + counts.hangul) / counts.letters : 0;
    return counts;
}

function meaningfulLyricLines(text = '') {
    return String(text || '').split(/\r?\n/)
        .map(line => normalizeSpaces(line))
        .filter(line => line && !/^\[[^\]]+\]$/.test(line));
}

function arabicLyricsQuality(text = '') {
    const lines = meaningfulLyricLines(text);
    const profile = scriptProfile(lines.join('\n'));
    let arabicLines = 0;
    for (const line of lines) {
        const p = scriptProfile(line);
        if (p.arabic >= 2 && p.arabicRatio >= 0.45) arabicLines++;
    }
    const lineRatio = lines.length ? arabicLines / lines.length : 0;
    // Arabic songs can legitimately contain a few English words/artist tags. Require
    // the actual lyric body to be predominantly Arabic rather than trusting a caption
    // language tag that YouTube may infer incorrectly for dialectal singing.
    let score = profile.arabicRatio * 0.68 + lineRatio * 0.32;
    if (profile.arabic < 12) score *= 0.35;
    else if (profile.arabic < 30) score *= 0.78;
    return { ...profile, lines: lines.length, arabicLines, lineRatio, score };
}

function lyricsTextFromResult(result) {
    if (!result) return '';
    const plain = result.plainLyrics ? String(result.plainLyrics) : '';
    const synced = Array.isArray(result.syncedLines) ? result.syncedLines.map(x => x?.text || '').join('\n') : '';
    // Some providers expose a shortened/plain preview while the timed lines contain
    // the complete lyric body. Language validation should inspect the richer text.
    return synced.length > plain.length ? synced : plain;
}

const CJK_LANGS = new Set(['ja', 'ko', 'zh']);
const EN_COMMON = new Set(('the a an and or but if then when while of to in on at for from with without my your his her our their me you he she we they it this that these those is am are was were be been being do does did have has had can could will would should may might must not no yes i im ive id ill youre youve youll dont cant wont didnt isnt arent wasnt werent its its just like love know want need feel make take come go get got see say said time heart baby tonight never always again one two all so too very here there now why how what who where because cause let lets').split(/\s+/));
const NON_EN_LATIN_HINTS = [
    new Set(('bir bu ben sen o biz siz onlar ve ama değil yok var ile için gibi çok daha mi mı mu mü ne neden nasıl burada şimdi seni bana benim senin aşk kalp gece hayır evet').split(/\s+/)),
    new Set(('que de la el y en un una por para con no si es soy eres somos son fue como pero mas muy mi tu su te me se lo las los del al porque cuando donde quien').split(/\s+/)),
    new Set(('de la le les un une et en des du pour avec pas est je tu il elle nous vous ils elles mon ton son mes tes ses mais ou comme tres').split(/\s+/)),
    new Set(('de o a os as um uma e em para por com não sim é eu tu ele ela nós vocês meu minha seu sua mas como muito').split(/\s+/)),
    new Set(('der die das und ein eine ist ich du er sie wir ihr nicht mit für von auf mein dein aber wie sehr').split(/\s+/)),
    new Set(('di il lo la i gli le un una e in per con non si è io tu lui lei noi voi mio tuo suo ma come molto').split(/\s+/)),
];

function latinTokens(text = '') {
    return String(text || '').toLowerCase().normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .match(/[a-z']{1,32}/g) || [];
}

const EN_IDENTITY_WORDS = new Set(('hello world life light lights dark dream dreams fire rain home stay away girl boy man woman dance dancing song songs bad guy good heart hearts night nights day days safe shape love lonely alone forever together broken beautiful beautiful crazy young old back down up high low lost found without inside outside tonight morning heaven hell star stars moon sun').split(/\s+/));

function identityStronglyEnglish(text = '') {
    const p = scriptProfile(text);
    if (p.arabic || p.kana || p.han || p.hangul || p.cyrillic || p.devanagari) return false;
    const tokens = latinTokens(text);
    if (!tokens.length || tokens.length > 18) return false;
    let hits = 0;
    for (const token of tokens) if (EN_COMMON.has(token) || EN_IDENTITY_WORDS.has(token)) hits++;
    const contraction = /\b(?:i['’]m|i['’]ve|i['’]ll|you['’]re|you['’]ve|we['’]re|they['’]re|don['’]t|can['’]t|won['’]t|isn['’]t|ain['’]t)\b/i.test(String(text || ''));
    return contraction || hits >= Math.max(2, Math.ceil(tokens.length * 0.35));
}

function englishLyricsQuality(text = '', explicitLanguage = '') {
    const p = scriptProfile(text);
    if (p.latin < 18 || p.latinRatio < 0.55) return 0;
    const explicit = langBase(explicitLanguage || '');
    if (explicit && explicit !== 'und' && explicit !== 'en') return 0;

    const tokens = latinTokens(text);
    if (!tokens.length) return 0;
    let englishHits = 0;
    const foreignHits = new Array(NON_EN_LATIN_HINTS.length).fill(0);
    for (const token of tokens) {
        if (EN_COMMON.has(token)) englishHits++;
        for (let i = 0; i < NON_EN_LATIN_HINTS.length; i++) if (NON_EN_LATIN_HINTS[i].has(token)) foreignHits[i]++;
    }
    const strongestForeign = Math.max(0, ...foreignHits);
    // Reject only when there is strong evidence for another Latin-script language.
    // This keeps short/stylised English lyrics from being over-filtered.
    if (!explicit && tokens.length >= 12 && strongestForeign >= 4 && strongestForeign >= englishHits + 3) return 0;
    const evidence = Math.min(1, (englishHits + 2) / Math.max(5, tokens.length * 0.20));
    return Math.min(1, 0.72 + evidence * 0.28);
}

const JA_ROMAJI_HINTS = new Set(('kono sono ano kimi boku bokura watashi watashiwa ore anata kare kanojo kokoro sora yume mirai koe uta hito sekai hikari yoru asa hi hoshi michi toki kaze namida egao omoi ai koi mada mata itsuka zutto motto doko nani dare doushite nande arigatou sayonara kimiwo kimi no ni wa wo ga e de to mo kara made koto tame dake demo yo ne da desu masu nai janai iru aru suru shite naru nara datte tte soshite dakara kitto motto konna sonna minna jibun mae ato naka saki').split(/\s+/));
const KO_ROMAN_HINTS = new Set(('na nae neo neoreul neon nega niga naneun nan geu geudae uri oneul jigeum bam nal haru maeum sarang saranghae hajima hajiman eotteoke ireoke geureoke tto deo modu eodi wae mwol mwo aniya gwaenchana apeuro dasi hamkke sesang kkum bit norae nunmul useum meolli gachi mannago bogosipeo').split(/\s+/));
const ZH_PINYIN_HINTS = new Set(('wo ni ta women nimen tamen de le shi zai bu hen ye dou yi ge ma ba ne zhe na shenme zenme meiyou you yao xiang ai xin tian di ye jiu rang kan ting shuo zou lai hui dao shang xia li wai jin wan ming bai zhi dao gan jue meng feng yu xing chen guang').split(/\s+/));
const ROMANIZATION_HINT_RE = /\b(?:romaji|romanji|romanized|romanised|romanization|romanisation|pinyin|phonetic|transliteration|latin\s+script)\b/i;

function cjkRomanizationEvidence(text = '', wanted = 'ja', result = null) {
    const profile = scriptProfile(text);
    if (profile.latin < 18 || profile.latinRatio < 0.58) return 0;

    const metadata = [result?.source, result?.title, result?.captionName, result?.captionLanguage, result?.language]
        .filter(Boolean).join(' ');
    const labeledRomanization = ROMANIZATION_HINT_RE.test(metadata)
        || /(?:^|[-_])latn(?:$|[-_])/i.test(String(result?.language || '')) || result?.romanizationHint === true;

    const tokens = latinTokens(text).filter(t => t.length >= 1);
    if (!tokens.length) return 0;
    let hints = 0;
    let distinctive = 0;
    const set = wanted === 'ja' ? JA_ROMAJI_HINTS : wanted === 'ko' ? KO_ROMAN_HINTS : ZH_PINYIN_HINTS;
    for (const token of tokens) {
        if (set.has(token)) hints++;
        if (wanted === 'ja' && /(?:shi|chi|tsu|kyo|ryo|nya|myo|gyo|jou|kyou|shou|chan|kun|sama|suki|kimi|boku|kokoro|mirai|arigatou)/i.test(token)) distinctive++;
        if (wanted === 'ko' && /(?:eo|eu|ae|ui|kk|tt|pp|jj|ch|ng|sarang|geu|neo|nae|haj|eott|gwen|gwaen)/i.test(token)) distinctive++;
        if (wanted === 'zh' && /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/i.test(token)) distinctive += 2;
        if (wanted === 'zh' && /^(?:[a-z]{1,6})[1-5]$/i.test(token)) distinctive += 2;
    }

    const needed = Math.max(3, Math.ceil(tokens.length * 0.16));
    const englishScore = englishLyricsQuality(text, '');
    const englishWords = tokens.filter(token => EN_COMMON.has(token)).length;
    // Generic particles such as "to" and "no" occur in both English and Romaji.
    // They cannot establish Japanese pronunciation in an overwhelmingly English body.
    if (englishWords >= Math.max(4, Math.ceil(tokens.length * 0.55))) return 0;
    if (hints + distinctive >= needed) return Math.min(0.96, 0.62 + (hints + distinctive) / Math.max(12, tokens.length));
    // A video title/format label cannot turn a translated English lyric body into
    // pronunciation. Validate its words before trusting the uploader's Romaji label.
    if (englishWords >= Math.max(4, Math.ceil(tokens.length * 0.30))) return 0;
    if (labeledRomanization) return 1;
    // Plain English translations are Latin-readable too, but they are not pronunciation
    // guides. Reject them unless there is positive transliteration evidence above.
    if (englishScore >= 0.82) return 0;
    return 0;
}

function cjkReadableQuality(text = '', wanted = 'ja', result = null) {
    const p = scriptProfile(text);
    const nativeChars = wanted === 'ja' ? p.kana + p.han : wanted === 'ko' ? p.hangul : p.han;
    const romanization = cjkRomanizationEvidence(text, wanted, result);
    if (romanization > 0) return { score: Math.min(1, 0.86 + romanization * 0.14), romanized: true, native: false, evidence: romanization };
    if (nativeChars >= 12) return { score: 0.58, romanized: false, native: true, evidence: 0 };
    return { score: 0, romanized: false, native: false, translatedLatin: p.latin >= 18 && p.latinRatio >= 0.58, evidence: 0 };
}

function lyricsLanguageQuality(result, preferredLanguage = 'en') {
    if (!result) return 0;
    const wanted = langBase(preferredLanguage || 'en');
    const text = lyricsTextFromResult(result);
    if (!text) return 0;

    // Arabic is deliberately strict. A Turkish/Latin auto-caption over an Arabic
    // performance is worse than a plain Arabic fallback because it is visibly wrong.
    if (wanted === 'ar' && config.LYRICS_ARABIC_STRICT !== false) {
        const q = arabicLyricsQuality(text);
        return q.score >= 0.52 && q.arabic >= 18 && q.arabicLines >= Math.min(3, Math.max(1, q.lines)) ? Math.min(1, 0.70 + q.score * 0.30) : 0;
    }

    // English tracks must stay English. A foreign auto-caption must never win just
    // because it has excellent timestamps.
    if (wanted === 'en' && config.LYRICS_ENGLISH_STRICT !== false) {
        return englishLyricsQuality(text, result.language || '');
    }

    // CJK tracks deliberately prefer a readable Latin romanisation (Romaji/Pinyin/
    // Korean romanization). Native-script lyrics remain a safe final fallback.
    if (CJK_LANGS.has(wanted)) return cjkReadableQuality(text, wanted, result).score;

    if (result.language && langMatches(result.language, wanted)) return 1;
    return LYRICS_ANY_LANGUAGE_FALLBACK ? 0.45 : 0;
}

function lyricsLanguageAcceptable(result, preferredLanguage = 'en') {
    return lyricsLanguageQuality(result, preferredLanguage) > 0;
}

function prefersRomanizedLyrics(preferredLanguage = 'en') {
    return CJK_LANGS.has(langBase(preferredLanguage || '')) && config.LYRICS_CJK_ROMANIZATION_PREFERRED !== false;
}

function resultIsRomanized(result, preferredLanguage = 'en') {
    if (!prefersRomanizedLyrics(preferredLanguage)) return false;
    return cjkReadableQuality(lyricsTextFromResult(result), langBase(preferredLanguage), result).romanized;
}

function pickBestLanguageResult(results = [], preferredLanguage = 'en', { syncedOnly = false } = {}) {
    const usable = results.filter(result => result && (!syncedOnly || result.syncedLines?.length) && lyricsLanguageAcceptable(result, preferredLanguage));
    if (!usable.length) return null;
    return usable.slice().sort((a, b) => {
        const aq = lyricsLanguageQuality(a, preferredLanguage);
        const bq = lyricsLanguageQuality(b, preferredLanguage);
        const aRoman = resultIsRomanized(a, preferredLanguage) ? 1 : 0;
        const bRoman = resultIsRomanized(b, preferredLanguage) ? 1 : 0;
        const aScore = Number(a.__score || 0) + aq * 140 + aRoman * 450;
        const bScore = Number(b.__score || 0) + bq * 140 + bRoman * 450;
        return bScore - aScore;
    })[0];
}

function inferPreferredLanguage(trackOrQuery, info = null, fallback = 'en') {
    const fields = typeof trackOrQuery === 'string'
        ? [trackOrQuery]
        : [
            trackOrQuery?.mediaTitle, trackOrQuery?.mediaArtist,
            trackOrQuery?.linkedTitle, trackOrQuery?.linkedArtist,
            trackOrQuery?.title, trackOrQuery?.author, trackOrQuery?.album,
        ];
    const metaFields = [info?.track, info?.alt_title, info?.artist, info?.album_artist, info?.title];
    const identity = [...fields, ...metaFields].filter(Boolean).join(' ');
    const idProfile = scriptProfile(identity);
    if (idProfile.arabic >= 3 && idProfile.arabicRatio >= 0.12) return 'ar';

    const description = String(info?.description || '');
    const descProfile = scriptProfile(description.slice(0, 9000));
    const hasArabicLyricsMarker = /(?:كلمات\s*(?:الأغنية|الاغنية)?|الكلمات\s*:|lyrics\s*:)/i.test(description);
    if (hasArabicLyricsMarker && descProfile.arabic >= 45 && descProfile.arabicRatio >= 0.30) return 'ar';

    const metaLanguage = langBase(info?.language || info?.original_language || '');
    const fallbackLanguage = langBase(fallback || 'en') || 'en';
    // ASR can mistake Japanese singing for Korean. A clearly identified Japanese
    // artist on an anime opening is stronger evidence than that automatic guess.
    const japaneseAnimeArtist = /\b(?:opening|ending|op|ed)\b/i.test(identity)
        && /\b(?:Konomi\s+Suzuki|Suzuki\s+Konomi)\b|鈴木\s*このみ/u.test(identity);
    if (japaneseAnimeArtist && !idProfile.hangul) return 'ja';
    // YouTube language detection is sometimes wrong on music uploads. If the visible
    // title/artist identity is strongly English, do not let a stray tr/es/etc tag make
    // the lyric resolver accept foreign captions. Short neutral Latin titles such as
    // CJK songs also use complete English titles, so their declared source language
    // still takes precedence over how the title is written.
    if (fallbackLanguage === 'en' && metaLanguage && metaLanguage !== 'en' && !CJK_LANGS.has(metaLanguage) && identityStronglyEnglish(identity)) return 'en';
    if (metaLanguage && metaLanguage !== 'und') return metaLanguage;
    return fallbackLanguage;
}


function normalizeArabicForSearch(text = '') {
    return String(text || '')
        .replace(/[\u064B-\u065F\u0670]/g, '') // tashkeel
        .replace(/ـ/g, '')
        .replace(/[إأآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
        .replace(/[^\p{Script=Arabic}A-Za-z0-9\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeForSearch(text = '') {
    const raw = String(text || '').toLowerCase();
    const arabic = normalizeArabicForSearch(raw);
    const latin = raw
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalizeSpaces(`${arabic} ${latin}`);
}

function keywordTokens(text = '') {
    const norm = normalizeForSearch(text);
    return norm.split(/\s+/).filter(w => w.length >= 2 && !/^(official|music|video|audio|lyrics|lyric|كلمات|اغنيه|اغنية|فيديو|رسمي|حصريا|حصري|slowed|reverb|edit)$/.test(w));
}

function relevanceScoreText(candidateText = '', targetTitle = '', targetArtist = '') {
    const cand = normalizeForSearch(candidateText);
    const titleTokens = keywordTokens(targetTitle);
    const artistTokens = keywordTokens(targetArtist);
    let score = 0;
    for (const t of titleTokens) if (cand.includes(t)) score += 3;
    for (const t of artistTokens) if (cand.includes(t)) score += 2;
    if (titleTokens.length && titleTokens.every(t => cand.includes(t))) score += 10;
    if (artistTokens.length && artistTokens.some(t => cand.includes(t))) score += 4;
    return score;
}

function looksRelevant(candidateTitle = '', targetTitle = '', targetArtist = '') {
    const score = relevanceScoreText(candidateTitle, targetTitle, targetArtist);
    const min = keywordTokens(targetTitle).length <= 1 ? 3 : 5;
    return score >= min;
}

function guessLyricsLanguage(rawTitle = '', rawAuthor = '') {
    const joined = `${rawTitle || ''} ${rawAuthor || ''}`;
    if (hasArabic(joined)) return 'ar';
    if (/[\u3040-\u30ff]/u.test(joined)) return 'ja';
    if (/[\uac00-\ud7af]/u.test(joined)) return 'ko';
    if (/[\u0400-\u04ff]/u.test(joined)) return 'ru';
    if (/[\u0900-\u097f]/u.test(joined)) return 'hi';
    // Han characters without Japanese kana are more likely Chinese. When yt-dlp
    // exposes an authoritative language later, findLyricsUncached() overrides this
    // ambiguous guess (important for Japanese titles written only in kanji).
    if (/[\u3400-\u9fff]/u.test(joined)) return 'zh';
    return 'en';
}

function langBase(lang = '') {
    return String(lang || '').toLowerCase().split('-')[0];
}

function langMatches(lang = '', wanted = '') {
    if (!lang || !wanted) return false;
    return langBase(lang) === langBase(wanted);
}

function stripDecorations(text) {
    let s = normalizeSpaces(text)
        .replace(/[\u200E\u200F]/g, '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/【[^】]*】/g, ' ');

    // Remove common YouTube decoration terms that destroy lyrics search accuracy.
    const noisy = [
        'official music video', 'official video', 'official audio', 'official lyric video',
        'lyrics video', 'lyric video', 'lyrics', 'audio', 'visualizer', 'music video',
        'sped up', 'speed up', 'slowed', 'slowed and reverb', 'slowed & reverb', 'reverb',
        'nightcore', 'bass boosted', '8d audio', 'hq', 'hd', 'remastered', 'extended',
        'tiktok version', 'edit', 'full song', 'live performance', 'live',
        'كلمات', 'اغنية', 'أغنية', 'فيديو كليب', 'الكليب الرسمي', 'الفيديو الرسمي',
        'حصريا', 'حصرياً', 'رسمي', 'الرسمية', 'الرسمي', 'بدون موسيقى', 'نسخة بطيئة'
    ];

    // Repeatedly remove parenthesized/bracketed noise, but keep artist/title content outside.
    s = s.replace(/\(([^)]*)\)/g, (m, inner) => {
        const low = inner.toLowerCase();
        return noisy.some(n => low.includes(n)) ? ' ' : ` ${inner} `;
    });

    s = s.replace(/\b(official|lyrics?|audio|video|visualizer|remaster(?:ed)?|extended|slowed|reverb|sped\s*up|nightcore|bass\s*boosted)\b/ig, ' ');
    s = s.replace(/(كلمات|اغنية|أغنية|فيديو كليب|الكليب الرسمي|الفيديو الرسمي|حصريا|حصرياً|رسمي|الرسمية|الرسمي|نسخة بطيئة)/g, ' ');
    s = s.replace(/[“”"'`]/g, '').replace(/[_]+/g, ' ');
    return normalizeSpaces(s);
}

function splitArtistTitle(rawTitle = '', rawAuthor = '') {
    const titleClean = stripDecorations(rawTitle);
    let artist = stripDecorations(rawAuthor).replace(/\s*-\s*topic$/i, '').replace(/\s*vevo$/i, '').trim();
    let title = titleClean;

    // Prefer "Artist - Title" when present.
    const parts = titleClean.split(/\s+[-–—|:]\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const left = parts[0];
        const right = parts.slice(1).join(' - ');
        if (left.length <= 80 && right.length >= 2) {
            artist = left;
            title = right;
        }
    }

    // If title contains "feat." keep it; LRCLIB handles it fairly well, but also a plain version is tried later.
    return { artist: normalizeSpaces(artist), title: normalizeSpaces(title) };
}

function simplifyForAlternate(title = '') {
    return stripDecorations(title)
        .replace(/\s+(feat\.?|ft\.?)\s+.*$/i, '')
        .replace(/\s+x\s+.*$/i, '')
        .trim();
}

function parseSyncedLyrics(text = '') {
    const rawLines = String(text || '').split(/\r?\n/);
    let offsetMs = 0;
    for (const raw of rawLines) {
        const m = String(raw || '').match(/^\s*\[offset\s*:\s*([+-]?\d+)\s*\]\s*$/i);
        if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n)) offsetMs = Math.max(-30_000, Math.min(30_000, n));
        }
    }

    const lines = [];
    // Support standard LRC [mm:ss.xx], millisecond fractions, the common
    // [mm:ss:xx] variant, and multiple timestamps attached to one lyric line.
    const timeRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const raw of rawLines) {
        const stamps = [];
        let m;
        timeRe.lastIndex = 0;
        let lastEnd = 0;
        while ((m = timeRe.exec(raw))) {
            const min = Number(m[1]);
            const sec = Number(m[2]);
            const fractionRaw = String(m[3] || '');
            const ms = fractionRaw ? Number(fractionRaw.padEnd(3, '0').slice(0, 3)) : 0;
            if (Number.isFinite(min) && Number.isFinite(sec) && sec < 60 && Number.isFinite(ms)) {
                stamps.push(min * 60 + sec + ms / 1000);
                lastEnd = timeRe.lastIndex;
            }
        }
        if (!stamps.length) continue;
        // Text starts after the final line timestamp. Enhanced LRC word-level
        // markers remain inside the text and are stripped while preserving words.
        const body = String(raw.slice(lastEnd) || '');
        const textLine = normalizeSpaces(body
            .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, ' '));
        const markers = [...body.matchAll(/<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g)];
        const segments = markers.map((marker, index) => {
            const fraction = Number(String(marker[3] || '').padEnd(3, '0').slice(0, 3)) / 1000;
            const time = Number(marker[1]) * 60 + Number(marker[2]) + fraction;
            const next = markers[index + 1];
            const nextTime = next ? Number(next[1]) * 60 + Number(next[2]) + Number(String(next[3] || '').padEnd(3, '0').slice(0, 3)) / 1000 : null;
            return { time, ...(nextTime > time ? { endTime: nextTime } : {}),
                text: body.slice(marker.index + marker[0].length, next?.index ?? body.length) };
        });
        for (const baseTime of stamps) {
            const line = { time: Math.max(0, baseTime + offsetMs / 1000), text: textLine || '♪' };
            const wordShift = baseTime - stamps[0] + offsetMs / 1000;
            attachProviderWordTimes(line, segments.map(segment => ({ ...segment, time: Math.max(0, segment.time + wordShift),
                ...(segment.endTime != null ? { endTime: Math.max(0, segment.endTime + wordShift) } : {}) })));
            lines.push(line);
        }
    }
    return lines.sort((a, b) => a.time - b.time);
}

function attachProviderWordTimes(line, segments = []) {
    const words = [];
    let cursor = 0, previousTime = -1;
    for (const segment of segments) {
        const text = cleanupCaptionText(segment?.text || '');
        if (!text) continue;
        const time = segment?.time == null ? NaN : Number(segment.time);
        const start = line.text.indexOf(text, cursor);
        if (!Number.isFinite(time) || time < 0 || time < previousTime || start < 0) return line;
        const endTime = segment?.endTime == null ? NaN : Number(segment.endTime);
        words.push({ text, time, ...(Number.isFinite(endTime) && endTime > time ? { endTime } : {}), charStart: start, charEnd: start + text.length });
        cursor = start + text.length;
        previousTime = time;
    }
    if (words.length && words.map(word => word.text).join('').replace(/\s+/g, '') === line.text.replace(/\s+/g, '')) {
        line.words = words;
        line.wordTimingMode = 'provider';
    }
    return line;
}

function scoreResult(item, targetTitle, targetArtist) {
    const tRaw = String(item?.trackName || item?.title || '');
    const aRaw = String(item?.artistName || item?.artist || '');
    const t = normalizeForSearch(tRaw);
    const a = normalizeForSearch(aRaw);
    const targetT = normalizeForSearch(targetTitle || '');
    const targetA = normalizeForSearch(targetArtist || '');
    let score = 0;
    if (item?.syncedLyrics) score += 45;
    if (item?.plainLyrics) score += 25;
    if (targetT && t === targetT) score += 70;
    else if (targetT && (t.includes(targetT) || targetT.includes(t))) score += 35;
    if (targetA && a === targetA) score += 45;
    else if (targetA && (a.includes(targetA) || targetA.includes(a))) score += 20;
    score += relevanceScoreText(`${tRaw} ${aRaw}`, targetTitle, targetArtist);
    const dur = Number(item?.duration || 0);
    if (dur > 0) score += 2;
    return score;
}
let lyricsHttpActive = 0;
const lyricsHttpWaiters = [];
let lyricsYtDlpActive = 0;
const lyricsYtDlpWaiters = [];

async function acquireLyricsHttpSlot() {
    if (lyricsHttpActive < LYRICS_HTTP_CONCURRENCY) {
        lyricsHttpActive++;
        return;
    }
    // A released slot is transferred directly to this waiter; do not increment
    // again after wake-up or a new arrival could race us above the hard limit.
    await new Promise(resolve => lyricsHttpWaiters.push(resolve));
}

function releaseLyricsHttpSlot() {
    const next = lyricsHttpWaiters.shift();
    if (next) next();
    else lyricsHttpActive = Math.max(0, lyricsHttpActive - 1);
}

async function withLyricsHttpSlot(work) {
    await acquireLyricsHttpSlot();
    try { return await work(); } finally { releaseLyricsHttpSlot(); }
}

async function acquireLyricsYtDlpSlot() {
    if (lyricsYtDlpActive < LYRICS_YTDLP_CONCURRENCY) {
        lyricsYtDlpActive++;
        return;
    }
    await new Promise(resolve => lyricsYtDlpWaiters.push(resolve));
}

function releaseLyricsYtDlpSlot() {
    const next = lyricsYtDlpWaiters.shift();
    if (next) next();
    else lyricsYtDlpActive = Math.max(0, lyricsYtDlpActive - 1);
}

async function withLyricsYtDlpSlot(work) {
    await acquireLyricsYtDlpSlot();
    try { return await work(); } finally { releaseLyricsYtDlpSlot(); }
}

async function fetchLyricsResponse(url, timeoutMs = 8000, extraHeaders = {}, readBody = res => res.text()) {
    // The timeout starts only after a global HTTP slot is acquired. Under heavy
    // multi-guild load, queueing behind the semaphore must not consume the
    // network timeout before the request has even started.
    return await withLyricsHttpSlot(async () => {
        const controller = new AbortController();
        let timer, response;
        try {
            const work = (async () => {
            response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'MusicByA/7.1 (+discord music bot)',
                    'Accept': 'application/json,text/plain,*/*',
                    ...extraHeaders,
                },
            });
            if (!response.ok) {
                const err = new Error(`HTTP ${response.status}`); err.status = response.status;
                const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
                err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(2500, retryAfter * 1000) : 0;
                throw err;
            }
            return await readBody(response);
            })();
            return await Promise.race([work, new Promise((_, reject) => {
                timer = setTimeout(() => { const error = Object.assign(new Error('Lyrics response body timed out.'), { name: 'AbortError' }); controller.abort(error); reject(error); }, timeoutMs);
            })]);
        } finally {
            clearTimeout(timer);
            if (controller.signal.aborted || !response?.ok) { try { await response?.body?.cancel?.(); } catch (_) {} }
        }
    });
}

async function fetchJson(url, timeoutMs = 8000, attempts = 2, extraHeaders = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
        try {
            return await fetchLyricsResponse(url, timeoutMs, extraHeaders, res => res.json());
        } catch (err) {
            lastError = err;
            const retryable = !err?.status || err.status === 429 || err.status >= 500;
            if (!retryable || attempt + 1 >= Math.max(1, attempts)) throw err;
            await new Promise(resolve => setTimeout(resolve, err?.retryAfterMs || 180 * (attempt + 1)));
        }
    }
    throw lastError || new Error('lyrics metadata request failed');
}

async function fetchLyricsText(url, timeoutMs = 9000, extraHeaders = {}) {
    return await fetchLyricsResponse(url, timeoutMs, extraHeaders, res => res.text());
}

async function tryLrclib(title, artist) {
    const params = new URLSearchParams();
    params.set('track_name', title);
    if (artist) params.set('artist_name', artist);
    const data = await fetchJson(`https://lrclib.net/api/search?${params.toString()}`);
    if (!Array.isArray(data) || !data.length) return null;
    const best = data
        .filter(x => x && (x.syncedLyrics || x.plainLyrics))
        .sort((a, b) => scoreResult(b, title, artist) - scoreResult(a, title, artist))[0];
    if (!best) return null;
    const syncedLines = parseSyncedLyrics(best.syncedLyrics || '');
    return {
        source: 'LRCLIB',
        title: best.trackName || title,
        artist: best.artistName || artist || '',
        album: best.albumName || '',
        duration: Number(best.duration || 0) || 0,
        plainLyrics: normalizeLyrics(best.plainLyrics || ''),
        syncedLyrics: best.syncedLyrics || '',
        syncedLines,
        hasSynced: syncedLines.length > 0,
    };
}

async function tryLyricsOvh(title, artist) {
    if (!title || !artist) return null;
    const data = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    const lyrics = normalizeLyrics(data?.lyrics || '');
    if (!lyrics || lyrics.length < 20) return null;
    return {
        source: 'lyrics.ovh',
        title,
        artist,
        album: '',
        duration: 0,
        plainLyrics: lyrics,
        syncedLyrics: '',
        syncedLines: [],
        hasSynced: false,
    };
}


function parseVttTime(t = '') {
    const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return null;
    const h = Number(m[1] || 0);
    const min = Number(m[2] || 0);
    const sec = Number(m[3] || 0);
    if (min >= 60 || sec >= 60) return null;
    const ms = Number((m[4] || '0').padEnd(3, '0').slice(0, 3));
    return h * 3600 + min * 60 + sec + ms / 1000;
}

function cleanupCaptionText(text = '') {
    return normalizeSpaces(String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\{[^}]+\}/g, ' '));
}

function parseVttCaptions(text = '') {
    const lines = [];
    const blocks = String(text || '').replace(/\r/g, '').split(/\n\n+/);
    for (const block of blocks) {
        const rows = block.split('\n').map(x => x.trim()).filter(Boolean);
        const timeRowIndex = rows.findIndex(r => r.includes('-->'));
        if (timeRowIndex < 0) continue;
        const [startRaw, endRaw] = rows[timeRowIndex].split('-->').map(x => x.trim());
        const start = parseVttTime(startRaw);
        if (start == null) continue;
        const caption = cleanupCaptionText(rows.slice(timeRowIndex + 1).join(' '));
        const end = parseVttTime(String(endRaw || '').split(/\s+/)[0]);
        if (caption) lines.push({ time: start, ...(end != null && end > start ? { endTime: end } : {}), text: caption });
    }
    return lines.sort((a, b) => a.time - b.time);
}

function parseJson3Captions(data) {
    const lines = [];
    const events = Array.isArray(data?.events) ? data.events : [];
    for (const ev of events) {
        if (ev?.tStartMs == null || String(ev.tStartMs).trim() === '') continue;
        const start = Number(ev.tStartMs) / 1000;
        if (!Number.isFinite(start) || start < 0) continue;
        const segs = Array.isArray(ev?.segs) ? ev.segs : [];
        const text = cleanupCaptionText(segs.map(s => s?.utf8 || '').join(''));
        if (text) {
            const duration = Number(ev?.dDurationMs);
            const endTime = ev?.dDurationMs != null && Number.isFinite(duration) && duration > 0 ? start + duration / 1000 : null;
            const line = { time: start, ...(endTime != null ? { endTime } : {}), text };
            if (segs.some(segment => segment?.tOffsetMs != null && Number.isFinite(Number(segment.tOffsetMs)))) {
                const segments = segs.map((segment, index) => ({ text: segment?.utf8 || '',
                    time: segment?.tOffsetMs != null ? start + Number(segment.tOffsetMs) / 1000 : index === 0 ? start : NaN }));
                for (let i = 0; i < segments.length; i++) {
                    const end = segments[i + 1]?.time ?? endTime;
                    if (end > segments[i].time) segments[i].endTime = end;
                }
                attachProviderWordTimes(line, segments);
            }
            lines.push(line);
        }
    }
    return lines.sort((a, b) => a.time - b.time);
}


function decodeXmlText(text = '') {
    return cleanupCaptionText(String(text || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(Number(n)); } catch (_) { return ''; } })
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (_) { return ''; } })
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' '));
}

function parseSrvCaptions(text = '') {
    const raw = String(text || '');
    const lines = [];
    // srv1/srv2 commonly use <text start="1.23" dur="...">text</text>.
    const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let m;
    while ((m = textRe.exec(raw))) {
        const attrs = m[1] || '';
        const startMatch = attrs.match(/\bstart=["']([^"']+)["']/i);
        const start = Number(startMatch?.[1]);
        const duration = Number(attrs.match(/\bdur=["']([^"']+)["']/i)?.[1]);
        const value = decodeXmlText(m[2]);
        if (Number.isFinite(start) && start >= 0 && value) lines.push({ time: start, ...(Number.isFinite(duration) && duration > 0 ? { endTime: start + duration } : {}), text: value });
    }
    if (lines.length) return lines.sort((a, b) => a.time - b.time);
    // srv3 can use millisecond ticks on <p t="1234" d="...">.
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((m = pRe.exec(raw))) {
        const attrs = m[1] || '';
        const t = Number(attrs.match(/\bt=["']([^"']+)["']/i)?.[1]);
        const start = Number.isFinite(t) ? t / 1000 : NaN;
        const duration = Number(attrs.match(/\bd=["']([^"']+)["']/i)?.[1]);
        const value = decodeXmlText(m[2]);
        if (Number.isFinite(start) && start >= 0 && value) lines.push({ time: start, ...(Number.isFinite(duration) && duration > 0 ? { endTime: start + duration / 1000 } : {}), text: value });
    }
    return lines.sort((a, b) => a.time - b.time);
}

function parseTtmlClock(value = '') {
    const v = String(value || '').trim();
    if (!v) return null;
    if (/^\d+(?:\.\d+)?s$/i.test(v)) return Number(v.slice(0, -1));
    if (/^\d+(?:\.\d+)?ms$/i.test(v)) return Number(v.slice(0, -2)) / 1000;
    return parseVttTime(v.replace(',', '.'));
}

function parseTtmlCaptions(text = '') {
    const raw = String(text || '');
    const lines = [];
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRe.exec(raw))) {
        const attrs = m[1] || '';
        const begin = attrs.match(/\bbegin=["']([^"']+)["']/i)?.[1];
        const start = parseTtmlClock(begin);
        const end = parseTtmlClock(attrs.match(/\bend=["']([^"']+)["']/i)?.[1]);
        const duration = parseTtmlClock(attrs.match(/\bdur=["']([^"']+)["']/i)?.[1]);
        const endTime = end != null && end > start ? end : duration != null && duration > 0 ? start + duration : null;
        const value = decodeXmlText(m[2]);
        if (start != null && Number.isFinite(start) && value) lines.push({ time: Math.max(0, start), ...(endTime != null ? { endTime } : {}), text: value });
    }
    return lines.sort((a, b) => a.time - b.time);
}

function parseSubtitlePayload(raw, ext = '') {
    const kind = String(ext || '').toLowerCase();
    if (kind === 'json3') {
        try { return parseJson3Captions(JSON.parse(raw)); } catch (_) { return []; }
    }
    if (kind === 'srv1' || kind === 'srv2' || kind === 'srv3') return parseSrvCaptions(raw);
    if (kind === 'ttml' || kind === 'dfxp') return parseTtmlCaptions(raw);
    return parseVttCaptions(raw);
}

function isArabicPromoOrCreditLine(line = '') {
    const s = normalizeSpaces(line);
    if (!s) return false;
    if (/^(?:https?:\/\/|www\.|#|@)/i.test(s)) return true;
    return /^(?:اشترك|تابع|للاستماع|لتحميل|للتواصل|انتاج|إنتاج|توزيع|مكس|ماستر|الحان|ألحان|غناء|كلمات\s*:|كلمات\s+و(?:الحان|ألحان)|إشراف|اشراف|تصوير|مونتاج|إخراج|اخراج|حقوق|twitter|instagram|facebook|snapchat|tiktok|spotify|anghami|apple\s+music)(?:\s|[:：-]|$)/i.test(s);
}

function extractArabicLyricsFromDescription(description = '') {
    const rawLines = String(description || '').replace(/\r/g, '').split('\n').map(x => normalizeSpaces(x));
    if (!rawLines.length) return '';

    const markerRe = /^(?:[\[(]?\s*)?(?:كلمات\s*(?:الأغنية|الاغنية)?|نص\s*الأغنية|lyrics\s*(?:of\s+the\s+song)?)(?:\s*[\]):：-])?\s*$/i;
    const markerIndex = rawLines.findIndex(line => markerRe.test(line));

    const collectBlock = start => {
        const out = [];
        let started = false;
        let misses = 0;
        for (let i = start; i < rawLines.length && i < start + 90; i++) {
            const line = rawLines[i];
            if (!line) {
                if (started) misses++;
                if (misses >= 3 && out.length >= 5) break;
                continue;
            }
            if (isArabicPromoOrCreditLine(line)) {
                if (started && out.length >= 5) break;
                continue;
            }
            const p = scriptProfile(line);
            const looksLyric = line.length >= 2 && line.length <= 180 && p.arabic >= 2 && p.arabicRatio >= 0.42;
            if (looksLyric) {
                out.push(line);
                started = true;
                misses = 0;
            } else if (started) {
                misses++;
                if (misses >= 2 && out.length >= 5) break;
            }
        }
        const text = normalizeLyrics(out.join('\n'));
        const q = arabicLyricsQuality(text);
        return q.arabic >= 45 && q.lines >= 5 && q.score >= 0.58 ? text : '';
    };

    if (markerIndex >= 0) {
        const marked = collectBlock(markerIndex + 1);
        if (marked) return marked;
    }

    // Some official Arabic uploads paste the lyric body without an explicit marker.
    // Search for the strongest contiguous Arabic block while rejecting credits/promo.
    let best = '';
    for (let i = 0; i < rawLines.length; i++) {
        const candidate = collectBlock(i);
        if (candidate.length > best.length) best = candidate;
        if (best.length > 500) break;
    }
    return best;
}

function captionTimingSkeletonLooksUseful(lines = [], duration = 0) {
    if (!Array.isArray(lines) || lines.length < 6) return false;
    const first = Math.max(0, Number(lines[0]?.time || 0));
    const last = Math.max(first, Number(lines[lines.length - 1]?.time || 0));
    const span = last - first;
    if (span < 25) return false;
    if (duration > 0 && span < Math.min(55, duration * 0.35)) return false;
    return true;
}

function alignPlainLyricsToTimingSkeleton(plainLyrics = '', timingLines = [], duration = 0) {
    const lyricLines = String(plainLyrics || '').split(/\r?\n/)
        .map(x => normalizeSpaces(x)).filter(Boolean);
    const skeleton = sanitizeCaptionLines(timingLines || []);
    if (lyricLines.length < 5 || !captionTimingSkeletonLooksUseful(skeleton, duration)) return [];

    const lyricWeights = lyricLines.map(line => Math.max(2, scriptProfile(line).arabic || line.length));
    const timingWeights = skeleton.map(line => Math.max(2, normalizeSpaces(line.text || '').length));
    const lyricTotal = lyricWeights.reduce((a, b) => a + b, 0) || lyricLines.length;
    const timingTotal = timingWeights.reduce((a, b) => a + b, 0) || skeleton.length;

    const timingCumulative = [];
    let tc = 0;
    for (const weight of timingWeights) {
        timingCumulative.push(tc / timingTotal);
        tc += weight;
    }

    const out = [];
    let lc = 0;
    let lastTime = -1;
    for (let i = 0; i < lyricLines.length; i++) {
        const fraction = Math.max(0, Math.min(0.999, lc / lyricTotal));
        let idx = 0;
        while (idx + 1 < timingCumulative.length && timingCumulative[idx + 1] <= fraction) idx++;
        let time = Math.max(0, Number(skeleton[idx]?.time || 0));
        if (lastTime >= 0 && time <= lastTime) time = lastTime + 0.12;
        if (duration > 0) time = Math.min(time, Math.max(0, duration - 0.1));
        out.push({ time, text: lyricLines[i] });
        lastTime = time;
        lc += lyricWeights[i];
    }
    return out;
}

function captionLooksMachineTranslated(sub = {}, info = {}, preferredLanguage = 'en') {
    const wanted = langBase(preferredLanguage || '');
    const native = langBase(info.language || info.original_language || '');
    const raw = String(sub.__lang || '').toLowerCase();
    const subBase = langBase(raw);
    if (!wanted || !native || wanted === native || !raw || subBase !== wanted) return false;
    if (/(?:^|-)orig(?:$|-)/i.test(raw)) return false;
    // yt-dlp labels automatic originals with -orig, while translated automatic
    // tracks use the target code. Manual translated tracks can be target-source
    // (e.g. en-ja). Both are translations, not lyric pronunciation/transcription.
    if (raw.split('-').slice(1).includes(native)) return true;
    return sub.__manual !== true;
}

function captionRomanizationHint(sub = {}, options = {}) {
    if (options.romanizationHint === true) return true;
    const meta = `${sub.__name || ''} ${sub.name || ''} ${sub.__lang || ''}`;
    return ROMANIZATION_HINT_RE.test(meta) || /(?:^|[-_])latn(?:$|[-_])/i.test(String(sub.__lang || ''));
}

function subtitleCandidates(info = {}, preferredLanguage = 'en') {
    const groups = [];
    // Manual subtitles are usually cleaner than automatic captions.
    if (info.subtitles) groups.push({ caps: info.subtitles, weight: 0, manual: true });
    if (info.automatic_captions) groups.push({ caps: info.automatic_captions, weight: 120, manual: false });

    const wanted = langBase(preferredLanguage || 'en');
    const native = langBase(info.language || info.original_language || '');
    const romanizedFirst = prefersRomanizedLyrics(wanted);
    const priorityBases = [...new Set([
        ...(romanizedFirst ? ['en', wanted, native] : [wanted, native]),
        'ja', 'en', 'ko', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'hi'
    ].filter(Boolean))];
    const extPriority = { json3: 0, vtt: 1, srv3: 2, srv2: 3, srv1: 4, ttml: 5, dfxp: 6 };
    const picks = [];
    const seen = new Set();

    function languagePenalty(lang, manual) {
        const base = langBase(lang);
        if (romanizedFirst && base === 'en') return 0;
        if (base === wanted) return romanizedFirst ? 2 : 0;
        if (native && base === native) return romanizedFirst ? 4 : 2;
        const i = priorityBases.indexOf(base);
        if (i >= 0) return 8 + i * 2;
        // Availability is more important than language when no preferred track exists.
        return manual ? 28 : 38;
    }

    for (const group of groups) {
        const caps = group.caps || {};
        const keys = Object.keys(caps);
        const ordered = [
            ...keys.filter(k => langBase(k) === wanted),
            ...keys.filter(k => native && langBase(k) === native && langBase(k) !== wanted),
            ...priorityBases.flatMap(base => keys.filter(k => langBase(k) === base)),
            ...keys,
        ];
        for (const lang of [...new Set(ordered)]) {
            if (!Array.isArray(caps[lang])) continue;
            for (const item of caps[lang]) {
                if (!item?.url) continue;
                const key = `${item.url}|${item.ext || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const score = group.weight + languagePenalty(lang, group.manual) + (extPriority[item.ext] ?? 9);
                picks.push({ ...item, __lang: lang, __score: score, __manual: group.manual, __name: String(item.name || '') });
            }
        }
    }

    return picks
        .filter(x => x?.url)
        .sort((a, b) => (a.__score ?? 999) - (b.__score ?? 999));
}

async function tryYouTubeCaptions(trackOrQuery, preferredLanguage = 'en', options = {}) {
    if (typeof trackOrQuery === 'string' || !trackOrQuery?.url) return null;
    if (sourceProviderForTrack(trackOrQuery) !== 'youtube') return null;
    let ytDlp;
    try { ytDlp = require('./ytDlpProvider'); } catch (_) { return null; }

    const info = await withLyricsYtDlpSlot(() => ytDlp.runYtDlpJson(['--dump-single-json', trackOrQuery.url], 18000, { provider: 'youtube', youtubeSkipTranslatedSubs: config.LYRICS_YOUTUBE_SKIP_TRANSLATED_CAPTIONS !== false }));
    let candidates = subtitleCandidates(info, preferredLanguage);
    if (options.manualOnly === true) candidates = candidates.filter(x => x.__manual === true);
    if (options.autoOnly === true) candidates = candidates.filter(x => x.__manual !== true);
    if (langBase(preferredLanguage) === 'ar') {
        const arabic = candidates.filter(x => langBase(x.__lang) === 'ar');
        const mislabeledProbe = candidates.filter(x => langBase(x.__lang) !== 'ar').slice(0, 2);
        candidates = [...arabic, ...mislabeledProbe];
    }
    if (!candidates.length) return null;

    for (const sub of candidates.slice(0, LYRICS_CAPTION_CANDIDATE_LIMIT)) {
        try {
            const wanted = langBase(preferredLanguage || 'en');
            if ((wanted === 'ar' || wanted === 'en' || CJK_LANGS.has(wanted)) && captionLooksMachineTranslated(sub, info, wanted)) continue;
            if (wanted === 'ar' && !sub.__manual) {
                const native = langBase(info.language || info.original_language || '');
                const subBase = langBase(sub.__lang || '');
                const explicitOriginal = /(?:^|-)orig(?:$|-)/i.test(String(sub.__lang || ''));
                // YouTube exposes machine-translated auto-caption tracks for many
                // languages. Arabic-looking text translated from a wrongly detected
                // Turkish/etc transcript is not trustworthy lyric text.
                if (subBase === 'ar' && native && native !== 'ar' && !explicitOriginal) continue;
            }
            const raw = await fetchLyricsText(sub.url, 9000, {
                'Accept': 'application/json,text/vtt,text/xml,text/plain,*/*',
            });
            let lines = parseSubtitlePayload(raw, sub.ext);
            lines = lines.filter(l => l.text && !/^\[?music\]?$/i.test(l.text)).slice(0, 500);
            if (lines.length >= 4) {
                const plainLyrics = normalizeLyrics(lines.map(l => l.text).join('\n'));
                const result = {
                    source: `YouTube captions${sub.__lang ? `/${sub.__lang}` : ''}${sub.ext ? `/${sub.ext}` : ''}`,
                    language: sub.__lang || preferredLanguage,
                    title: trackOrQuery.title || info.title || '',
                    artist: trackOrQuery.author || info.uploader || info.channel || '',
                    album: '',
                    duration: Number(trackOrQuery.duration || info.duration || 0) || 0,
                    plainLyrics,
                    syncedLyrics: '',
                    syncedLines: lines,
                    hasSynced: true,
                    captionName: sub.__name || sub.name || '',
                    captionLanguage: sub.__lang || '',
                    captionManual: sub.__manual === true,
                    romanizationHint: captionRomanizationHint(sub, options),
                };
                if (!lyricsLanguageAcceptable(result, preferredLanguage)) continue;
                return result;
            }
        } catch (_) {}
    }
    return null;
}


async function tryYouTubeSearchCaptions(rawTitle = '', rawAuthor = '', preferredLanguage = 'en') {
    let ytDlp;
    try { ytDlp = require('./ytDlpProvider'); } catch (_) { return null; }
    const { artist, title } = splitArtistTitle(rawTitle, rawAuthor);
    const altTitle = simplifyForAlternate(title);
    const baseQueries = buildLyricsQueryVariants(rawTitle, rawAuthor, preferredLanguage)
        .filter(q => /\blyrics\b/i.test(q) || /كلمات/.test(q) || q === title || q === altTitle)
        .slice(0, 8);
    const searchQueries = [...new Set(baseQueries.map(q => {
        if (/\blyrics\b/i.test(q) || /كلمات/.test(q)) return q;
        return (preferredLanguage === 'ar' || hasArabic(q)) ? `${q} كلمات` : `${q} lyrics`;
    }))];

    for (const query of searchQueries) {
        let results = [];
        try { results = await withLyricsYtDlpSlot(() => ytDlp.search(query, { limit: 4 })); } catch (_) { results = []; }
        for (const candidate of results.slice(0, 4)) {
            const candidateTitle = `${candidate.title || ''} ${candidate.author || ''}`;
            // لا نقبل نتائج بعيدة جداً حتى لا نرجع كلمات عشوائية.
            if (!looksRelevant(candidateTitle, title || rawTitle, artist || rawAuthor) && results.indexOf(candidate) > 0) continue;
            try {
                const got = await tryYouTubeCaptions(candidate, preferredLanguage);
                if (!got || !got.plainLyrics) continue;
                if (!lyricsLanguageAcceptable(got, preferredLanguage)) continue;
                got.source = `${got.source || 'YouTube captions'} • search`;
                got.title = got.title || candidate.title || title;
                got.artist = got.artist || candidate.author || artist;
                return got;
            } catch (_) {}
        }
    }
    return null;
}

async function tryLrclibQuery(q) {
    const query = normalizeSpaces(q);
    if (!query) return null;
    const data = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);
    if (!Array.isArray(data) || !data.length) return null;
    const best = data
        .filter(x => x && (x.syncedLyrics || x.plainLyrics))
        .sort((a, b) => scoreResult(b, query, '') - scoreResult(a, query, ''))[0];
    if (!best) return null;
    const syncedLines = parseSyncedLyrics(best.syncedLyrics || '');
    return {
        source: 'LRCLIB',
        title: best.trackName || query,
        artist: best.artistName || '',
        album: best.albumName || '',
        duration: Number(best.duration || 0) || 0,
        plainLyrics: normalizeLyrics(best.plainLyrics || ''),
        syncedLyrics: best.syncedLyrics || '',
        syncedLines,
        hasSynced: syncedLines.length > 0,
    };
}


async function tryLrclibGet(title, artist, album = '') {
    if (!title) return null;
    const params = new URLSearchParams();
    params.set('track_name', title);
    if (artist) params.set('artist_name', artist);
    if (album) params.set('album_name', album);
    try {
        const best = await fetchJson(`https://lrclib.net/api/get?${params.toString()}`, 8000);
        if (!best || (!best.syncedLyrics && !best.plainLyrics)) return null;
        const syncedLines = parseSyncedLyrics(best.syncedLyrics || '');
        return {
            source: 'LRCLIB exact',
            title: best.trackName || title,
            artist: best.artistName || artist || '',
            album: best.albumName || album || '',
            duration: Number(best.duration || 0) || 0,
            plainLyrics: normalizeLyrics(best.plainLyrics || ''),
            syncedLyrics: best.syncedLyrics || '',
            syncedLines,
            hasSynced: syncedLines.length > 0,
        };
    } catch (_) {
        return null;
    }
}

function buildLyricsQueryVariants(rawTitle = '', rawAuthor = '', preferredLanguage = 'en') {
    const { artist, title } = splitArtistTitle(rawTitle, rawAuthor);
    const altTitle = simplifyForAlternate(title);
    const cleanRaw = stripDecorations(rawTitle);
    const cleanArtist = stripDecorations(rawAuthor).replace(/\s*[-–—]?\s*(topic|vevo)$/i, '').trim();
    const variants = [
        title,
        altTitle,
        artist && title ? `${artist} - ${title}` : '',
        artist && altTitle ? `${artist} - ${altTitle}` : '',
        artist && title ? `${artist} ${title}` : '',
        title && artist ? `${title} ${artist}` : '',
        cleanRaw,
        cleanArtist && cleanRaw ? `${cleanArtist} ${cleanRaw}` : '',
    ];
    if (preferredLanguage === 'ar' || hasArabic(`${rawTitle} ${rawAuthor}`)) {
        variants.push(
            title ? `${title} كلمات` : '',
            artist && title ? `${artist} ${title} كلمات` : '',
            artist && altTitle ? `${artist} ${altTitle} كلمات` : '',
            cleanRaw ? `${cleanRaw} كلمات` : '',
            title ? `${title} lyrics` : ''
        );
    } else {
        variants.push(
            artist && title ? `${artist} ${title} lyrics` : '',
            title ? `${title} lyrics` : '',
            artist && altTitle ? `${artist} ${altTitle} lyrics` : ''
        );
    }
    return [...new Set(variants.map(normalizeSpaces).filter(Boolean))].slice(0, 18);
}

function normalizeLyrics(text = '') {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[\t ]+$/gm, '')
        .trim();
}

const VERSION_PATTERN = /\b(remix|mix|edit|rework|bootleg|vip|mashup|flip|acoustic|live|instrumental|karaoke|sped\s*up|speed\s*up|slowed(?:\s*&\s*reverb)?|nightcore|radio\s*edit|extended(?:\s*mix)?|club\s*mix|original\s*mix|remaster(?:ed)?(?:\s*\d{4})?|demo|version)\b/i;
const GENERIC_VERSION_WORDS_RE = /\b(remix|mix|edit|rework|bootleg|vip|mashup|flip|acoustic|live|instrumental|karaoke|sped|speed|up|slowed|reverb|nightcore|radio|extended|club|original|remaster(?:ed)?|demo|version)\b/gi;

function cleanIdentityText(value = '') {
    return normalizeSpaces(String(value || '')
        .replace(/[‐‑‒–—−]+/g, '-')
        .replace(/[“”"'`]/g, '')
        .replace(/\([^)]*(?:حصري(?:ا|اً)?|رسمي(?:ا|اً)?|الفيديو\s+الرسمي|الكليب\s+الرسمي|كلمات)[^)]*\)/ig, ' ')
        .replace(/\[[^\]]*(?:حصري(?:ا|اً)?|رسمي(?:ا|اً)?|الفيديو\s+الرسمي|الكليب\s+الرسمي|كلمات)[^\]]*\]/ig, ' ')
        .replace(/(?:حصري(?:ا|اً)?|الفيديو\s+الرسمي|الكليب\s+الرسمي)/ig, ' ')
        .replace(/\b(?:official\s+(?:music\s+)?(?:video|audio)|official\s+lyrics?|lyrics?\s+video|lyric\s+video|visualizer|music\s+video|mv|hq|hd|4k|8k)\b/ig, ' ')
        .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
        .replace(/\s+/g, ' '));
}

function normalizeIdentity(value = '') {
    return cleanIdentityText(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}&+()\[\]{}\-\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function identityTokens(value = '') {
    return normalizeIdentity(value).replace(/[()\[\]{}]/g, ' ').split(/\s+/).filter(Boolean);
}

function tokenSimilarity(a = '', b = '') {
    const aa = new Set(identityTokens(a));
    const bb = new Set(identityTokens(b));
    if (!aa.size || !bb.size) return 0;
    let shared = 0;
    for (const x of aa) if (bb.has(x)) shared++;
    const recall = shared / aa.size;
    const precision = shared / bb.size;
    return recall * 0.72 + precision * 0.28;
}

function normalizeIdentityLoose(value = '') {
    return normalizeIdentity(value)
        .replace(/[إأآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/\s+/g, ' ')
        .trim();
}

function charDiceSimilarity(a = '', b = '') {
    const aa = normalizeIdentityLoose(a).replace(/\s+/g, ' ');
    const bb = normalizeIdentityLoose(b).replace(/\s+/g, ' ');
    if (!aa || !bb) return 0;
    if (aa === bb) return 1;
    const compactA = aa.replace(/\s+/g, '');
    const compactB = bb.replace(/\s+/g, '');
    if (compactA.length >= 4 && compactB.length >= 4 && (compactA.includes(compactB) || compactB.includes(compactA))) {
        const ratio = Math.min(compactA.length, compactB.length) / Math.max(compactA.length, compactB.length);
        return Math.min(0.98, 0.82 + ratio * 0.16);
    }
    const grams = text => {
        const out = new Map();
        const s = ` ${text} `;
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            out.set(g, (out.get(g) || 0) + 1);
        }
        return out;
    };
    const ga = grams(aa), gb = grams(bb);
    let overlap = 0, totalA = 0, totalB = 0;
    for (const n of ga.values()) totalA += n;
    for (const n of gb.values()) totalB += n;
    for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0);
    return totalA + totalB ? (2 * overlap) / (totalA + totalB) : 0;
}

function identitySimilarity(a = '', b = '') {
    const token = tokenSimilarity(a, b);
    const chars = charDiceSimilarity(a, b);
    return Math.max(token, chars * 0.96);
}

function cleanArtistDeep(value = '') {
    return cleanIdentityText(value)
        .replace(/\s*[-–—]?\s*(?:topic|vevo)$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}


const CURATOR_CHANNEL_RE = /\b(?:proximity|trap nation|chill nation|bass nation|mrsuicidesheep|cloudkid|xkito|7clouds|wave music|ncs|no copyright sounds|monstercat|ukf|liquicity|suicide sheep|dynmk|koala kontrol|future house music)\b/i;
function uploaderLooksLikeCuratorDeep(value = '') {
    const v = cleanArtistDeep(value);
    return Boolean(v && (CURATOR_CHANNEL_RE.test(v) || /\b(?:records?|music|network|nation|promotion|promotions|premieres?|uploads?|channel)\b/i.test(v)));
}
function plausibleArtistPrefixDeep(value = '') {
    const v = cleanArtistDeep(value);
    if (!v || v.length > 120) return false;
    const words = identityTokens(v);
    if (!words.length || words.length > 9) return false;
    return !/\b(?:official|audio|video|lyrics?|visualizer|playlist|compilation)\b/i.test(v);
}
function splitArtistTitleDeep(rawTitle = '', rawAuthor = '') {
    const rawInput = String(rawTitle || '');
    let title = cleanIdentityText(rawInput);
    let artist = cleanArtistDeep(rawAuthor);
    const quoted = rawInput.match(/^(.{1,160}?)\s*["“]([^"”]{2,120})["”](.*)$/u);
    if (quoted) {
        const left = cleanArtistDeep(quoted[1].replace(/[\s:|\-–—]+$/g, ''));
        const qTitle = cleanIdentityText(quoted[2]);
        const tail = cleanIdentityText(quoted[3] || '');
        const authorNorm = normalizeIdentity(artist);
        const leftNorm = normalizeIdentity(left);
        const overlap = !artist || identitySimilarity(leftNorm, authorNorm) >= 0.34 || leftNorm.includes(authorNorm) || authorNorm.includes(leftNorm);
        if (left && qTitle && overlap) {
            artist = left;
            title = qTitle + (VERSION_PATTERN.test(tail) ? ` ${tail}` : '');
        }
    }
    // Explicit dash/pipe separators are strong evidence in YouTube music titles.
    // Keep ':' out because artists such as SawanoHiroyuki[nZk]:... legitimately use it.
    const parts = title.split(/\s+[-–—|]\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const left = parts[0];
        const right = parts.slice(1).join(' - ');
        const authorNorm = normalizeIdentity(artist);
        const leftNorm = normalizeIdentity(left);
        const leftTokens = new Set(identityTokens(left));
        const authorTokens = identityTokens(artist);
        const authorContained = authorTokens.length > 0 && authorTokens.some(t => leftTokens.has(t));
        const curatorUploader = uploaderLooksLikeCuratorDeep(artist);
        const strongDelimiterArtist = plausibleArtistPrefixDeep(left) && right.length >= 2 && parts.length <= 3;
        const plausibleArtistPrefix = left.length <= 120 && right.length >= 2 && (
            !artist || authorContained || identitySimilarity(leftNorm, authorNorm) >= 0.34 || leftNorm.includes(authorNorm) || authorNorm.includes(leftNorm) || curatorUploader || strongDelimiterArtist
        );
        if (plausibleArtistPrefix) {
            artist = left;
            title = right;
        }
    }
    if (artist) {
        const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        title = title.replace(new RegExp(`^${escaped}\\s*[-–—|:]\\s*`, 'i'), '').trim();
    }
    return { artist: cleanArtistDeep(artist), title: cleanIdentityText(title) };
}

function extractVersionProfile(value = '') {
    const raw = cleanIdentityText(value);
    const normalized = normalizeIdentity(raw);
    const tags = [];
    const tagMatchers = [
        ['remix', /\bremix\b/i], ['edit', /\bedit\b/i], ['rework', /\brework\b/i],
        ['bootleg', /\bbootleg\b/i], ['vip', /\bvip\b/i], ['mashup', /\bmashup\b/i],
        ['flip', /\bflip\b/i], ['acoustic', /\bacoustic\b/i], ['live', /\blive\b/i],
        ['instrumental', /\binstrumental\b/i], ['karaoke', /\bkaraoke\b/i],
        ['spedup', /\b(?:sped|speed)\s*up\b/i], ['slowed', /\bslowed\b/i],
        ['nightcore', /\bnightcore\b/i], ['radioedit', /\bradio\s*edit\b/i],
        ['extended', /\bextended(?:\s*mix)?\b/i], ['clubmix', /\bclub\s*mix\b/i],
        ['originalmix', /\boriginal\s*mix\b/i], ['remaster', /\bremaster(?:ed)?(?:\s*\d{4})?\b/i],
        ['demo', /\bdemo\b/i],
    ];
    for (const [tag, re] of tagMatchers) if (re.test(normalized)) tags.push(tag);
    if (!tags.length && /\bmix\b/i.test(normalized)) tags.push('mix');
    if (!tags.length && /\bversion\b/i.test(normalized)) tags.push('version');

    const phrases = [];
    const bracketRe = /\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g;
    let m;
    while ((m = bracketRe.exec(raw))) {
        const inner = m[1] || m[2] || m[3] || '';
        if (VERSION_PATTERN.test(inner)) phrases.push(inner);
    }
    // Only use a dash/colon suffix when no bracketed version phrase was found.
    // Otherwise "Artist - Song (Remixer Remix)" used to capture the *whole song*
    // into version.names, making the exact remix look different from itself.
    if (!phrases.length) {
        const suffix = raw.match(/(?:-|–|—|:)\s*([^\n]*(?:remix|edit|rework|bootleg|vip|mashup|flip|acoustic|live|instrumental|sped\s*up|slowed|nightcore|radio\s*edit|extended|club\s*mix|original\s*mix|remaster(?:ed)?|demo|version)[^\n]*)$/i);
        if (suffix?.[1]) phrases.push(suffix[1]);
    }
    const hint = normalizeIdentity(phrases.join(' ') || (tags.length ? raw : ''));
    const names = normalizeIdentity(hint.replace(GENERIC_VERSION_WORDS_RE, ' '));
    return { altered: tags.length > 0, tags: [...new Set(tags)], hint, names };
}

function stripVersionDeep(value = '') {
    let raw = cleanIdentityText(value);
    raw = raw
        .replace(/\([^)]*(?:remix|mix|edit|rework|bootleg|vip|mashup|flip|acoustic|live|instrumental|karaoke|sped\s*up|slowed|nightcore|radio\s*edit|extended|club\s*mix|original\s*mix|remaster(?:ed)?|demo|version)[^)]*\)/ig, ' ')
        .replace(/\[[^\]]*(?:remix|mix|edit|rework|bootleg|vip|mashup|flip|acoustic|live|instrumental|karaoke|sped\s*up|slowed|nightcore|radio\s*edit|extended|club\s*mix|original\s*mix|remaster(?:ed)?|demo|version)[^\]]*\]/ig, ' ')
        .replace(/(?:-|–|—|:)\s*[^\n]*(?:remix|edit|rework|bootleg|vip|mashup|flip|acoustic|live|instrumental|sped\s*up|slowed|nightcore|radio\s*edit|extended|club\s*mix|original\s*mix|remaster(?:ed)?|demo|version)[^\n]*$/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return raw;
}

function versionRelation(wantedTitle = '', candidateTitle = '') {
    const wanted = extractVersionProfile(wantedTitle);
    const got = extractVersionProfile(candidateTitle);
    if (!wanted.altered && !got.altered) return { score: 1, mismatch: false, missing: false, wanted, got };
    if (!wanted.altered && got.altered) return { score: 0.08, mismatch: true, missing: false, wanted, got };
    if (wanted.altered && !got.altered) return { score: 0.42, mismatch: false, missing: true, wanted, got };
    const sharedTags = wanted.tags.filter(x => got.tags.includes(x));
    if (!sharedTags.length) return { score: 0, mismatch: true, missing: false, wanted, got };
    const tagScore = sharedTags.length / Math.max(wanted.tags.length, got.tags.length);
    const nameScore = wanted.names && got.names ? identitySimilarity(wanted.names, got.names) : (wanted.names || got.names ? 0.42 : 1);
    // Two named remixes with different remixer names must never be treated as the same timed version.
    if (wanted.names && got.names && nameScore < 0.45) return { score: Math.min(0.28, tagScore * 0.28), mismatch: true, missing: false, wanted, got };
    return { score: Math.max(0, Math.min(1, tagScore * 0.55 + nameScore * 0.45)), mismatch: false, missing: false, wanted, got };
}

function durationRelation(targetDuration = 0, candidateDuration = 0) {
    const a = Number(targetDuration || 0), b = Number(candidateDuration || 0);
    if (!(a > 0) || !(b > 0)) return { score: 0.48, known: false, delta: Infinity, close: false };
    const delta = Math.abs(a - b);
    const tolerance = Math.max(2.0, Math.min(5.0, a * 0.018));
    let score = 0;
    if (delta <= 1.25) score = 1;
    else if (delta <= tolerance) score = 0.92;
    else if (delta <= 7) score = 0.72;
    else if (delta <= 12) score = 0.45;
    else if (delta <= 22) score = 0.20;
    else score = 0;
    return { score, known: true, delta, close: delta <= tolerance };
}


function extractAnimeMusicIdentities(rawTitle = '', rawAuthor = '', duration = 0) {
    const raw = normalizeSpaces(String(rawTitle || '').replace(/[‐‑‒–—−]+/g, '-')
        .replace(/\s*(?:\([^)]*\b(?:lyrics?|romaji|romanized)\b[^)]*\)|\[[^\]]*\b(?:lyrics?|romaji|romanized)\b[^\]]*\])\s*$/i, ''));
    const author = cleanArtistDeep(rawAuthor);
    const out = [];
    const seen = new Set();
    const add = (title, artist = '') => {
        title = cleanIdentityText(title).replace(/^(?:full\s+)?(?:opening|ending|op|ed)\s*\d*\s*/i, '').trim();
        artist = cleanArtistDeep(artist);
        if (!title || title.length < 2 || title.length > 160) return;
        const key = `${normalizeIdentity(title)}|${normalizeIdentity(artist)}`;
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(makeTargetIdentity(title, artist || author, duration));
    };

    // Both quoted and unquoted FULL openings carry a song identity after the
    // format marker; the uploader/show prefix does not identify the performer.
    let m = raw.match(/(?:\bopening\b|\bending\b|\bop\b|\bed\b)(?:\s*\d+)?\s*(?:full\s*)?(?:[-|:]\s*)?["“]?([^|]{2,140}?)\s*["”]?\s+by\s+([^|\[\]()]{2,100})$/i);
    if (m) {
        add(m[1], m[2]);
        // Japanese artists appear in both family/given-name order in catalogs.
        const alternate = m[2].replace(/\bKonomi\s+Suzuki\b/i, 'Suzuki Konomi');
        if (alternate !== m[2]) add(m[1], alternate);
    }

    // Quoted song names are common in anime uploads: ... "Song Title" by Artist.
    m = raw.match(/["“]([^"”]{2,140})["”]\s*(?:by|[-|])\s*([^|\[\]()]{2,100})/i);
    if (m) add(m[1], m[2]);

    // Japanese anime uploads often use corner quotes: OP「曲名」アーティスト.
    const jpQuoted = raw.match(/[「『]([^」』]{2,120})[」』]\s*(?:[-–—|:/]\s*)?([^|\[\]【】()]{2,80})?$/u);
    if (jpQuoted) add(jpQuoted[1], jpQuoted[2] || '');

    // Opening/ending upload conventions: "... Opening Full - Song by Artist".
    m = raw.match(/(?:opening|ending|\bop\b|\bed\b)[^|:\-]{0,50}\s*(?:[-|:]\s*)?([^|]{2,140}?)\s+by\s+([^|\[\]()]{2,100})(?:$|[|\[])/i);
    if (m) add(m[1], m[2]);

    // Generic but only enabled for anime/OST-like titles to avoid over-parsing ordinary song names.
    if (/\b(?:anime|opening|ending|\bop\b|\bed\b|ost|theme|season)\b/i.test(raw)) {
        m = raw.match(/(?:[-|:]\s*)([^|:\-]{2,140}?)\s+by\s+([^|\[\]()]{2,100})(?:$|[|\[])/i);
        if (m) add(m[1], m[2]);
        m = raw.match(/(?:[-|:]\s*)([^|:\-]{2,120}?)\s*[-–—]\s*([^|\[\]()]{2,90})$/i);
        if (m) add(m[1], m[2]);
    }
    return out.slice(0, 5);
}

function extractBilingualMusicIdentities(rawTitle = '', rawAuthor = '', duration = 0) {
    const raw = normalizeSpaces(String(rawTitle || '').replace(/[‐‑‒–—−]+/g, '-'));
    const out = [];
    const seen = new Set();
    const add = (title, artist = '') => {
        const id = makeTargetIdentity(title, artist || rawAuthor, duration);
        if (!id?.title) return;
        const key = `${normalizeIdentity(id.title)}|${normalizeIdentity(id.artist)}`;
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(id);
    };

    // Official Arabic uploads frequently use:
    // "Artist - Arabic Title | 2020 | Artist - Latin Transliteration".
    // Treat each side as a first-class identity instead of one giant exact string.
    const chunks = raw.split(/\s*[|｜]\s*/u)
        .map(x => x.trim())
        .filter(x => x && !/^\d{4}(?:\s*[-/]\s*\d{2,4})?$/.test(x));
    for (const chunk of chunks.slice(0, 8)) {
        const parts = chunk.split(/\s+[-–—]\s+/u).map(x => x.trim()).filter(Boolean);
        if (parts.length >= 2 && parts[0].length <= 100) {
            add(parts.slice(1).join(' - '), parts[0]);
        } else if (chunk.length >= 2 && chunk.length <= 180) {
            add(chunk, rawAuthor);
        }
    }
    return out.slice(0, 8);
}

function extractMetadataDescriptionIdentities(info = null, duration = 0) {
    if (!info) return [];
    const desc = String(info.description || '').replace(/\r/g, '');
    if (!desc) return [];
    const out = [];
    const seen = new Set();
    const add = (title, artist = '') => {
        title = cleanIdentityText(title);
        artist = cleanArtistDeep(artist);
        if (!title || title.length < 2 || title.length > 160) return;
        const key = `${normalizeIdentity(title)}|${normalizeIdentity(artist)}`;
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(makeTargetIdentity(title, artist, duration, info.album || ''));
    };
    const titleMatch = desc.match(/(?:^|\n)\s*(?:song|track|title)\s*[:：-]\s*([^\n]{2,160})/i);
    const artistMatch = desc.match(/(?:^|\n)\s*(?:artist|singer|performed\s+by|vocals?)\s*[:：-]\s*([^\n]{2,120})/i);
    if (titleMatch) add(titleMatch[1], artistMatch?.[1] || info.artist || info.album_artist || '');
    const provided = desc.match(/Provided to YouTube by[^\n]*\n+\s*([^\n]{2,150})\s*\n+\s*([^\n]{2,120})/i);
    if (provided) add(provided[1], provided[2]);
    return out.slice(0, 4);
}

function makeTargetIdentity(rawTitle, rawAuthor, duration = 0, album = '') {
    const split = splitArtistTitleDeep(rawTitle, rawAuthor);
    const title = split.title || cleanIdentityText(rawTitle);
    const artist = split.artist || cleanArtistDeep(rawAuthor);
    return {
        title,
        artist,
        album: cleanIdentityText(album),
        baseTitle: stripVersionDeep(title).replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '').trim(),
        version: extractVersionProfile(title),
        duration: Number(duration || 0) || 0,
    };
}

function lyricArtistVariants(value = '') {
    const full = cleanArtistDeep(value);
    const parts = full.split(/\s*(?:&|,|\bx\b|\bwith\b|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b)\s*/i)
        .map(cleanArtistDeep).filter(Boolean);
    return [...new Set([full, ...parts].filter(Boolean))].slice(0, 5);
}

function dedupeIdentities(items = []) {
    const out = [];
    const seen = new Set();
    for (const x of items) {
        if (!x?.title) continue;
        const key = `${normalizeIdentity(x.title)}|${normalizeIdentity(x.artist)}|${normalizeIdentity(x.album)}`;
        if (!key || seen.has(key)) continue;
        seen.add(key); out.push(x);
    }
    return out;
}

function sourceProviderForTrack(trackOrQuery) {
    const explicit = String(trackOrQuery?.provider || '').toLowerCase();
    if (explicit) return explicit;
    try { return require('./sourceResolver').classifyUrl(trackOrQuery?.url)?.provider || 'generic'; }
    catch (_) { return 'generic'; }
}

async function fetchTrackMetadata(trackOrQuery) {
    if (typeof trackOrQuery === 'string' || !trackOrQuery?.url) return null;
    const key = String(trackOrQuery.url);
    const cached = metadataCache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    let value = null;
    try {
        const ytDlp = require('./ytDlpProvider');
        const provider = sourceProviderForTrack(trackOrQuery);
        value = await withLyricsYtDlpSlot(() => ytDlp.runYtDlpJson(
            ['--dump-single-json', '--skip-download', trackOrQuery.url],
            LYRICS_METADATA_TIMEOUT_MS,
            { provider, youtubeSkipTranslatedSubs: provider === 'youtube' && config.LYRICS_YOUTUBE_SKIP_TRANSLATED_CAPTIONS !== false },
        ));
    } catch (_) { value = null; }
    metadataCache.set(key, { value, until: Date.now() + (value ? METADATA_CACHE_TTL_MS : METADATA_MISS_TTL_MS) });
    while (metadataCache.size > 250) metadataCache.delete(metadataCache.keys().next().value);
    return value;
}

function buildTargetContext(trackOrQuery, info = null) {
    const rawTitle = typeof trackOrQuery === 'string' ? trackOrQuery : (trackOrQuery?.title || '');
    const rawAuthor = typeof trackOrQuery === 'string' ? '' : (trackOrQuery?.author || '');
    const rawDuration = typeof trackOrQuery === 'string' ? 0 : Number(trackOrQuery?.duration || 0);
    const identities = [
        makeTargetIdentity(rawTitle, rawAuthor, rawDuration, trackOrQuery?.album || ''),
        ...extractBilingualMusicIdentities(rawTitle, rawAuthor, rawDuration),
        ...extractAnimeMusicIdentities(rawTitle, rawAuthor, rawDuration),
    ];
    if (typeof trackOrQuery !== 'string') {
        const mediaTitle = trackOrQuery?.mediaTitle || trackOrQuery?.linkedTitle || '';
        const mediaArtist = trackOrQuery?.mediaArtist || trackOrQuery?.albumArtist || '';
        if (mediaTitle) identities.unshift(makeTargetIdentity(mediaTitle, mediaArtist || rawAuthor, rawDuration, trackOrQuery?.album || ''));
    }
    if (info) {
        const metaTitle = info.track || info.alt_title || info.title || '';
        const metaArtist = info.artist || info.album_artist || info.creator || info.uploader || rawAuthor;
        const metaAlbum = info.album || info.album_title || '';
        const metaDuration = Number(info.duration || rawDuration || 0);
        if (metaTitle) identities.unshift(makeTargetIdentity(metaTitle, metaArtist, metaDuration, metaAlbum));
        if (info.title && info.title !== metaTitle) identities.push(makeTargetIdentity(info.title, metaArtist, metaDuration, metaAlbum));
        identities.push(...extractBilingualMusicIdentities(info.title || rawTitle, metaArtist, metaDuration));
        if (rawTitle && metaArtist) identities.push(makeTargetIdentity(rawTitle, metaArtist, metaDuration, metaAlbum));
        identities.push(...extractAnimeMusicIdentities(info.title || rawTitle, metaArtist, metaDuration));
        identities.push(...extractMetadataDescriptionIdentities(info, metaDuration));
    }
    const animeIdentities = [
        ...extractAnimeMusicIdentities(rawTitle, rawAuthor, rawDuration),
        ...extractAnimeMusicIdentities(info?.title || '', info?.artist || rawAuthor, Number(info?.duration || rawDuration || 0)),
    ];
    const explicitMusicMetadata = Boolean(info?.track || trackOrQuery?.mediaTitle || trackOrQuery?.linkedTitle);
    const list = dedupeIdentities(explicitMusicMetadata ? identities : [...animeIdentities, ...identities]);
    const alteredIdentity = list.find(x => x.version?.altered && x.version.names) || list.find(x => x.version?.altered) || list[0];
    return {
        identities: list,
        primary: list[0] || makeTargetIdentity(rawTitle, rawAuthor, rawDuration),
        alteredIdentity,
        altered: Boolean(list.some(x => x.version?.altered)),
        duration: Number(info?.duration || rawDuration || 0) || 0,
        rawTitle,
        rawAuthor,
        info,
    };
}

function candidateMetrics(item, target) {
    const title = String(item?.trackName || item?.title || '');
    const artist = String(item?.artistName || item?.artist || '');
    const duration = Number(item?.duration || 0) || 0;
    let best = null;
    for (const wanted of target.identities) {
        const baseSim = identitySimilarity(wanted.baseTitle || wanted.title, stripVersionDeep(title));
        const fullSim = identitySimilarity(wanted.title, title);
        const artistSim = wanted.artist && artist ? identitySimilarity(wanted.artist, artist) : (wanted.artist ? 0 : 0.55);
        const localVersion = versionRelation(wanted.title, title);
        // If any trustworthy identity says the playing source is a remix/edit/live/etc,
        // that explicit version controls timing safety. A metadata alias that omits the
        // remix tag must never let an original-version timing slip through.
        const version = target.altered
            ? versionRelation(target.alteredIdentity?.title || wanted.title, title)
            : localVersion;
        const durationFit = durationRelation(target.duration || wanted.duration, duration);
        if (version.mismatch) continue;
        if (baseSim < 0.50 && fullSim < 0.56) continue;
        if (wanted.artist && artist && artistSim < 0.36) continue;
        let score = baseSim * 260 + fullSim * 120 + artistSim * 155 + version.score * 220 + durationFit.score * 180;
        if (normalizeIdentity(wanted.title) === normalizeIdentity(title)) score += 90;
        if (normalizeIdentity(wanted.artist) && normalizeIdentity(wanted.artist) === normalizeIdentity(artist)) score += 45;
        if (item?.syncedLyrics) score += 70;
        if (item?.plainLyrics) score += 25;
        const namedVersion = Boolean(target.alteredIdentity?.version?.names);
        const missingVersionTimingSafe = version.missing && durationFit.known && (namedVersion ? durationFit.delta <= 2.0 : durationFit.close);
        // A generic label such as simply "Remix" can identify many different edits.
        // If no remixer/version name exists, require matching duration before trusting timings.
        const explicitVersionTimingSafe = version.score >= 0.72 && (namedVersion || (durationFit.known && durationFit.close));
        if (target.altered && version.missing) score -= missingVersionTimingSafe ? 10 : 110;
        if (target.altered && !namedVersion && version.score >= 0.72 && !durationFit.close) score -= 85;
        if (!target.altered && extractVersionProfile(title).altered) score -= 180;
        // Even an exact title/remixer name may describe an album cut, radio edit,
        // extended upload or different intro. Known duration disagreement invalidates
        // its timestamps; preserve the matching words for a labeled plain fallback.
        const durationTimingSafe = !durationFit.known || durationFit.close;
        const syncSafe = !version.mismatch && durationTimingSafe && (!target.altered || explicitVersionTimingSafe || missingVersionTimingSafe);
        const identityConfidence = Math.max(baseSim, fullSim) * 0.68 + artistSim * 0.32;
        const current = { score, baseSim, fullSim, artistSim, identityConfidence, version, localVersion, durationFit, namedVersion, explicitVersionTimingSafe, missingVersionTimingSafe, syncSafe, title, artist, duration };
        if (!best || current.score > best.score) best = current;
    }
    return best || { score: -Infinity, syncSafe: false, title, artist, duration, version: { mismatch: true }, durationFit: durationRelation(target.duration, duration) };
}

function lrclibToResult(item, target, source = 'LRCLIB deep') {
    if (!item || (!item.syncedLyrics && !item.plainLyrics)) return null;
    const metrics = candidateMetrics(item, target);
    if (!Number.isFinite(metrics.score) || metrics.score < 360) return null;
    const titleConfidence = Math.max(Number(metrics.baseSim || 0), Number(metrics.fullSim || 0));
    const strongApproxIdentity = Number(metrics.identityConfidence || 0) >= 0.84
        || (!metrics.artist && titleConfidence >= 0.94 && metrics.durationFit?.close)
        || (Number(metrics.artistSim || 0) >= 0.90 && titleConfidence >= 0.80 && metrics.durationFit?.close);
    if (!strongApproxIdentity) return null;
    let syncedLines = parseSyncedLyrics(item.syncedLyrics || '');
    let plainLyrics = normalizeLyrics(item.plainLyrics || '');
    if (!plainLyrics && syncedLines.length) plainLyrics = normalizeLyrics(syncedLines.map(x => x.text).join('\n'));
    // Never animate a remix/edit with timings from a different version. Plain text is safer than wrong motion.
    if (!metrics.syncSafe) syncedLines = [];
    return {
        source,
        title: item.trackName || item.title || target.primary.title,
        artist: item.artistName || item.artist || target.primary.artist,
        album: item.albumName || item.album || '',
        duration: Number(item.duration || 0) || 0,
        plainLyrics,
        syncedLyrics: metrics.syncSafe ? String(item.syncedLyrics || '') : '',
        syncedLines,
        hasSynced: syncedLines.length > 0,
        __score: metrics.score + (syncedLines.length ? 110 : 0),
        __metrics: metrics,
    };
}

async function runBounded(tasks, limit = LYRICS_HTTP_CONCURRENCY) {
    if (!tasks.length) return [];
    const out = new Array(tasks.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (true) {
            const i = index++;
            if (i >= tasks.length) return;
            try { out[i] = { status: 'fulfilled', value: await tasks[i]() }; }
            catch (reason) { out[i] = { status: 'rejected', reason }; }
        }
    });
    await Promise.all(workers);
    return out;
}

function lrclibTaskUrls(target) {
    const urls = [];
    const add = (url, type) => { if (url && !urls.some(x => x.url === url)) urls.push({ url, type }); };
    for (const id of target.identities.slice(0, 4)) {
        if (!id.title) continue;
        const artistOptions = lyricArtistVariants(id.artist);
        const exactArtists = artistOptions.length ? artistOptions.slice(0, 3) : [''];
        for (const a of exactArtists) {
            const exact = new URLSearchParams();
            exact.set('track_name', id.title);
            if (a) exact.set('artist_name', a);
            if (id.album) exact.set('album_name', id.album);
            if (target.duration > 0) exact.set('duration', String(Math.round(target.duration)));
            add(`https://lrclib.net/api/get?${exact.toString()}`, 'exact');

            const structured = new URLSearchParams();
            structured.set('track_name', id.title);
            if (a) structured.set('artist_name', a);
            add(`https://lrclib.net/api/search?${structured.toString()}`, 'structured');
        }

        const variants = [];
        const push = q => { q = normalizeSpaces(q); if (q && !variants.includes(q)) variants.push(q); };
        push(`${id.artist} ${id.title}`);
        push(`${id.title} ${id.artist}`);
        push(id.title);
        push(`${id.artist} ${id.baseTitle}`);
        push(id.baseTitle);
        if (id.version?.hint) push(`${id.baseTitle} ${id.version.hint}`);
        for (const a of artistOptions) {
            push(`${a} ${id.title}`);
            push(`${a} ${id.baseTitle}`);
            if (id.version?.hint) push(`${a} ${id.baseTitle} ${id.version.hint}`);
        }
        for (const q of variants) add(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, 'query');
    }
    return urls.slice(0, LYRICS_DEEP_QUERY_LIMIT);
}

function providerResultsFromSettled(settled, target, prefix) {
    const rawItems = [];
    for (const r of settled) {
        if (r?.status !== 'fulfilled') continue;
        const { entry, data } = r.value || {};
        if (Array.isArray(data)) rawItems.push(...data.map(item => ({ item, source: entry?.type || 'search' })));
        else if (data && typeof data === 'object') rawItems.push({ item: data, source: entry?.type || 'exact' });
    }
    const seen = new Set();
    const results = [];
    for (const { item, source } of rawItems) {
        const key = String(item?.id || `${normalizeIdentity(item?.trackName)}|${normalizeIdentity(item?.artistName)}|${Number(item?.duration || 0)}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const result = lrclibToResult(item, target, `${prefix} ${source}`);
        if (result) results.push(result);
    }
    results.sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0));
    return results;
}

function hasHighConfidenceSynced(results = [], preferredLanguage = '') {
    // A perfect/near-perfect identity+duration match scores well above 1000.
    // Returning it immediately avoids broad provider searches without accepting
    // questionable remix/original timings (lrclibToResult already enforces syncSafe).
    return results.some(r => r?.syncedLines?.length && Number(r.__score || 0) >= 1000
        && (!preferredLanguage || lyricsLanguageAcceptable(r, preferredLanguage)));
}

async function deepLrclibSearch(target, preferredLanguage = '') {
    const urls = lrclibTaskUrls(target);
    // Common-case fast lane: exact/structured lookups for the strongest identities.
    // Broad q= variants are kept as the deep fallback only when needed.
    const primary = [
        ...urls.filter(x => x.type === 'exact').slice(0, 4),
        ...urls.filter(x => x.type === 'structured').slice(0, 4),
    ];
    const primaryKeys = new Set(primary.map(x => x.url));
    const secondary = urls.filter(x => !primaryKeys.has(x.url));
    const run = entries => runBounded(entries.map(entry => async () => ({ entry, data: await fetchJson(entry.url, 8500) })), LYRICS_HTTP_CONCURRENCY);

    const first = providerResultsFromSettled(await run(primary), target, 'LRCLIB');
    if (hasHighConfidenceSynced(first, preferredLanguage) || !secondary.length) return first;

    const second = providerResultsFromSettled(await run(secondary), target, 'LRCLIB');
    const merged = [...first, ...second];
    const seen = new Set();
    return merged.filter(r => {
        const key = `${normalizeIdentity(r.title)}|${normalizeIdentity(r.artist)}|${Number(r.duration || 0)}|${r.source}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    }).sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0));
}

const karalyrMissCache = new Map();
const KARALYR_MISS_TTL_MS = Math.max(5 * 60_000, Number(config.LYRICS_KARALYR_MISS_TTL_MS || 30 * 60_000));

function karalyrTargetKey(target) {
    const id = target?.primary || {};
    return hashKey(`${normalizeIdentity(id.title)}|${normalizeIdentity(id.artist)}|${Math.round(Number(target?.duration || 0))}`);
}

function karalyrTaskUrls(target) {
    const urls = [];
    const add = (url, type) => { if (url && !urls.some(x => x.url === url)) urls.push({ url, type }); };
    const limit = Math.max(2, Math.min(12, Number(config.LYRICS_KARALYR_QUERY_LIMIT || 8)));
    for (const id of target.identities.slice(0, 4)) {
        if (!id.title) continue;
        const artists = lyricArtistVariants(id.artist);
        for (const artist of (artists.length ? artists.slice(0, 2) : [''])) {
            const exact = new URLSearchParams();
            exact.set('track_name', id.title);
            if (artist) exact.set('artist_name', artist);
            if (id.album) exact.set('album_name', id.album);
            if (target.duration > 0) exact.set('duration', String(Math.round(target.duration)));
            add(`https://karalyr.com/api/get?${exact.toString()}`, 'exact');
        }
        const search = new URLSearchParams();
        search.set('track_name', id.title);
        if (id.artist) search.set('artist_name', id.artist);
        add(`https://karalyr.com/api/search?${search.toString()}`, 'search');
    }
    return urls.slice(0, limit);
}

async function deepKaralyrSearch(target, preferredLanguage = '') {
    if (config.LYRICS_KARALYR_ENABLED === false) return [];
    const missKey = karalyrTargetKey(target);
    const missUntil = Number(karalyrMissCache.get(missKey) || 0);
    if (missUntil > Date.now()) return [];
    if (missUntil) karalyrMissCache.delete(missKey);
    const urls = karalyrTaskUrls(target);
    const concurrency = Math.max(1, Math.min(6, Number(config.LYRICS_KARALYR_CONCURRENCY || 4)));
    const primary = urls.filter(x => x.type === 'exact').slice(0, 4);
    const primaryKeys = new Set(primary.map(x => x.url));
    const secondary = urls.filter(x => !primaryKeys.has(x.url));
    const run = entries => runBounded(entries.map(entry => async () => ({
        entry,
        data: await fetchJson(entry.url, 6500, 1, { 'X-Karalyr-Client': 'MusicByA/6.4.0' }),
    })), concurrency);

    let results = providerResultsFromSettled(await run(primary), target, 'Karalyr');
    if (!hasHighConfidenceSynced(results, preferredLanguage) && secondary.length) {
        const more = providerResultsFromSettled(await run(secondary), target, 'Karalyr');
        results = [...results, ...more].sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0));
    }
    // Deduplicate possible exact/search copies of the same provider row.
    const seen = new Set();
    results = results.filter(r => {
        const key = `${normalizeIdentity(r.title)}|${normalizeIdentity(r.artist)}|${Number(r.duration || 0)}|${hashKey(lyricsTextFromResult(r))}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });

    if (!results.length) {
        karalyrMissCache.set(missKey, Date.now() + KARALYR_MISS_TTL_MS);
        while (karalyrMissCache.size > 250) karalyrMissCache.delete(karalyrMissCache.keys().next().value);
    } else {
        karalyrMissCache.delete(missKey);
    }
    return results;
}


const lrcMuxMissCache = new Map();
const LRCMUX_MISS_TTL_MS = Math.max(5 * 60_000, Number(config.LYRICS_LRCMUX_MISS_TTL_MS || 20 * 60_000));

function lrcMuxTargetKey(target) {
    const id = target?.alteredIdentity || target?.primary || {};
    return hashKey(`${normalizeIdentity(id.title)}|${normalizeIdentity(id.artist)}|${normalizeIdentity(id.album)}|${Math.round(Number(target?.duration || 0))}`);
}

function lrcMuxTaskUrls(target) {
    const limit = Math.max(1, Math.min(4, Number(config.LYRICS_LRCMUX_QUERY_LIMIT || 2)));
    const ordered = dedupeIdentities([
        target?.alteredIdentity,
        ...(target?.identities || []),
    ].filter(Boolean));
    const out = [];
    for (let i = 0; i < ordered.length && out.length < limit; i++) {
        const id = ordered[i];
        if (!id?.title || !id?.artist) continue;
        const q = new URLSearchParams();
        q.set('artist', id.artist);
        q.set('title', id.title);
        if (id.album) q.set('album', id.album);
        if (Number(target?.duration || 0) > 0) q.set('duration', String(Math.round(Number(target.duration))));
        out.push({ url: `https://api.lrcmux.dev/get?${q.toString()}`, identity: id, identityIndex: i });
    }
    return out;
}

function lrcMuxToResult(data, target, entry) {
    if (!data || typeof data !== 'object' || data?.meta?.instrumental === true) return null;
    const rawLines = Array.isArray(data.lines) ? data.lines : [];
    const plainLines = [];
    const syncedLines = [];
    for (const line of rawLines.slice(0, 900)) {
        const text = normalizeSpaces(line?.text || '');
        if (!text) continue;
        plainLines.push(text);
        const rawStart = line?.start;
        // The API uses null for untimed lines. Number(null)/Number('') is zero,
        // which otherwise makes a plain body look fully synchronized at 00:00.
        const startMs = rawStart == null || String(rawStart).trim() === '' ? NaN : Number(rawStart);
        const rawEnd = line?.end;
        const endMs = rawEnd == null || String(rawEnd).trim() === '' ? NaN : Number(rawEnd);
        if (Number.isFinite(startMs) && startMs >= 0) syncedLines.push({ time: startMs / 1000,
            ...(Number.isFinite(endMs) && endMs > startMs ? { endTime: endMs / 1000 } : {}), text });
    }
    const plainLyrics = normalizeLyrics(plainLines.join('\n'));
    if (!plainLyrics && !syncedLines.length) return null;

    const id = entry?.identity || target?.primary || {};
    const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    const responseTitle = meta.trackName || meta.track_name || meta.title || data.trackName || data.track_name || data.title || '';
    const responseArtist = meta.artistName || meta.artist_name || meta.artist || data.artistName || data.artist_name || data.artist || '';
    const responseDuration = [meta.duration, data.duration].map(Number).find(value => Number.isFinite(value) && value > 0) || 0;
    const metrics = candidateMetrics({ trackName: responseTitle || id.title, artistName: responseArtist || id.artist, duration: responseDuration }, target);
    if (!Number.isFinite(metrics.score) || (responseTitle && metrics.identityConfidence < 0.80)) return null;
    // A query's requested duration is not a measured response duration. In
    // particular, an original-title alias cannot prove that returned cues belong
    // to a remix. Require an explicit version or actual close response duration.
    const versionIdentified = !metrics.version?.missing || (responseDuration > 0 && metrics.syncSafe);
    const allowSync = metrics.syncSafe && (!target?.altered || (Number(target?.duration || 0) > 0 && versionIdentified));
    const safeSynced = allowSync ? syncedLines.sort((a, b) => a.time - b.time) : [];
    return {
        source: `lrcmux${data?.meta?.level ? `/${String(data.meta.level)}` : ''}`,
        title: responseTitle || id.title || target?.primary?.title || '',
        artist: responseArtist || id.artist || target?.primary?.artist || '',
        album: id.album || target?.primary?.album || '',
        duration: responseDuration || Number(target?.duration || 0) || 0,
        plainLyrics,
        syncedLyrics: '',
        syncedLines: safeSynced,
        hasSynced: safeSynced.length > 0,
        __score: 980 - Math.max(0, Number(entry?.identityIndex || 0)) * 40 + (safeSynced.length ? 80 : 0),
    };
}

async function deepLrcMuxSearch(target) {
    if (config.LYRICS_LRCMUX_ENABLED === false) return [];
    const missKey = lrcMuxTargetKey(target);
    const missUntil = Number(lrcMuxMissCache.get(missKey) || 0);
    if (missUntil > Date.now()) return [];
    if (missUntil) lrcMuxMissCache.delete(missKey);

    const entries = lrcMuxTaskUrls(target);
    const concurrency = Math.max(1, Math.min(3, Number(config.LYRICS_LRCMUX_CONCURRENCY || 2)));
    const settled = await runBounded(entries.map(entry => async () => ({
        entry,
        data: await fetchJson(entry.url, 5000, 1, { 'X-Lrcmux-Client': 'MusicByA/6.4.0' }),
    })), concurrency);
    const results = [];
    for (const r of settled) {
        if (r?.status !== 'fulfilled') continue;
        const result = lrcMuxToResult(r.value?.data, target, r.value?.entry);
        if (result) results.push(result);
    }
    results.sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0));
    if (!results.length) {
        lrcMuxMissCache.set(missKey, Date.now() + LRCMUX_MISS_TTL_MS);
        while (lrcMuxMissCache.size > 250) lrcMuxMissCache.delete(lrcMuxMissCache.keys().next().value);
    } else {
        lrcMuxMissCache.delete(missKey);
    }
    return results;
}

function sanitizeCaptionLines(lines = []) {
    const out = [];
    let previous = '';
    let previousTime = -1;
    for (const line of lines) {
        const text = cleanupCaptionText(line?.text || '');
        if (!text || /^(?:[♪♫♬\s]+|[\[(]?(?:music|applause|foreign|instrumental|silence|eumak|음악|音楽|音乐|موسيقى)[\])]?)$/iu.test(text)) continue;
        const norm = normalizeIdentity(text);
        const time = Math.max(0, Number(line?.time || 0));
        // Repeated choruses/echoes are separate sung events. Deduplicate only an
        // identical cue at the same timestamp, not every repeat of its words.
        if (norm && norm === previous && Math.abs(time - previousTime) < 0.001) continue;
        previous = norm;
        previousTime = time;
        out.push({ ...line, time, text });
        if (out.length >= 700) break;
    }
    return out;
}

function captionsLookUseful(lines = [], duration = 0) {
    if (!Array.isArray(lines) || lines.length < 5) return false;
    const combined = lines.map(x => String(x.text || '')).join(' ');
    const words = combined.split(/\s+/).filter(Boolean).length;
    // Japanese/Chinese/Korean lyrics often have no spaces at all. Counting only
    // whitespace-delimited words incorrectly rejected perfectly good CJK captions.
    const cjkChars = (combined.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/gu) || []).length;
    if (words < 18 && cjkChars < 24) return false;
    if (cjkChars < 24 && new Set(latinTokens(combined)).size < 3) return false;
    if (duration > 0 && lines.length >= 8) {
        const last = Number(lines[lines.length - 1]?.time || 0);
        if (last > 0 && last < Math.min(35, duration * 0.18)) return false;
    }
    return true;
}

async function tryYouTubeCaptionsWithInfo(trackOrQuery, preferredLanguage = 'en', info = null, options = {}) {
    if (typeof trackOrQuery === 'string' || !trackOrQuery?.url) return null;
    if (!info) {
        try { info = await fetchTrackMetadata(trackOrQuery); } catch (_) { info = null; }
    }
    if (!info) return null;
    let candidates = subtitleCandidates(info, preferredLanguage);
    if (options.manualOnly === true) candidates = candidates.filter(x => x.__manual === true);
    if (options.autoOnly === true) candidates = candidates.filter(x => x.__manual !== true);
    if (langBase(preferredLanguage) === 'ar') {
        const arabic = candidates.filter(x => langBase(x.__lang) === 'ar');
        // Probe at most two mislabeled tracks in case YouTube tagged genuine Arabic
        // speech incorrectly. Their text still has to pass the Arabic-script validator.
        const mislabeledProbe = candidates.filter(x => langBase(x.__lang) !== 'ar').slice(0, 2);
        candidates = [...arabic, ...mislabeledProbe];
    }
    if (!candidates.length) return null;
    for (const sub of candidates.slice(0, LYRICS_CAPTION_CANDIDATE_LIMIT)) {
        try {
            const wanted = langBase(preferredLanguage || 'en');
            if ((wanted === 'ar' || wanted === 'en' || CJK_LANGS.has(wanted)) && captionLooksMachineTranslated(sub, info, wanted)) continue;
            if (wanted === 'ar' && !sub.__manual) {
                const native = langBase(info.language || info.original_language || '');
                const subBase = langBase(sub.__lang || '');
                const explicitOriginal = /(?:^|-)orig(?:$|-)/i.test(String(sub.__lang || ''));
                if (subBase === 'ar' && native && native !== 'ar' && !explicitOriginal) continue;
            }
            const raw = await fetchLyricsText(sub.url, 9000, {
                'Accept': 'application/json,text/vtt,text/xml,text/plain,*/*',
            });
            let lines = parseSubtitlePayload(raw, sub.ext);
            lines = sanitizeCaptionLines(lines);
            const duration = Number(trackOrQuery.duration || info.duration || 0) || 0;
            if (!captionsLookUseful(lines, duration)) continue;
            const plainLyrics = normalizeLyrics(lines.map(l => l.text).join('\n'));
            const result = {
                source: `YouTube exact captions${sub.__lang ? `/${sub.__lang}` : ''}${sub.ext ? `/${sub.ext}` : ''}`,
                language: sub.__lang || preferredLanguage,
                title: info.track || info.title || trackOrQuery.title || '',
                artist: info.artist || trackOrQuery.author || info.uploader || info.channel || '',
                album: info.album || '',
                duration,
                plainLyrics,
                syncedLyrics: '',
                syncedLines: lines,
                hasSynced: true,
                __score: 1200,
                captionName: sub.__name || sub.name || '',
                captionLanguage: sub.__lang || '',
                captionManual: sub.__manual === true,
                romanizationHint: captionRomanizationHint(sub, options),
            };
            if (!lyricsLanguageAcceptable(result, preferredLanguage)) continue;
            return result;
        } catch (_) {}
    }
    return null;
}

async function tryYouTubeCaptionTimingSkeletonWithInfo(trackOrQuery, info = null, preferredLanguage = 'ar') {
    if (typeof trackOrQuery === 'string' || !trackOrQuery?.url) return null;
    if (!info) {
        try { info = await fetchTrackMetadata(trackOrQuery); } catch (_) { info = null; }
    }
    if (!info) return null;
    const candidates = subtitleCandidates(info, preferredLanguage);
    for (const sub of candidates.slice(0, Math.min(10, LYRICS_CAPTION_CANDIDATE_LIMIT))) {
        try {
            const raw = await fetchLyricsText(sub.url, 8500, { 'Accept': 'application/json,text/vtt,text/xml,text/plain,*/*' });
            const lines = sanitizeCaptionLines(parseSubtitlePayload(raw, sub.ext));
            const duration = Number(trackOrQuery.duration || info.duration || 0) || 0;
            if (!captionTimingSkeletonLooksUseful(lines, duration)) continue;
            return { lines, language: sub.__lang || '', duration };
        } catch (_) {}
    }
    return null;
}

async function tryEmbeddedArabicLyrics(trackOrQuery, target, info = null, options = {}) {
    if (config.LYRICS_ARABIC_DESCRIPTION_FALLBACK === false) return null;
    if (!info || inferPreferredLanguage(trackOrQuery, info, 'en') !== 'ar') return null;
    const plainLyrics = extractArabicLyricsFromDescription(info.description || '');
    if (!plainLyrics) return null;
    const q = arabicLyricsQuality(plainLyrics);
    if (q.score < 0.58) return null;

    const result = {
        source: 'Source description • Arabic lyrics',
        language: 'ar',
        title: target?.primary?.title || info.track || info.title || trackOrQuery?.title || '',
        artist: target?.primary?.artist || info.artist || trackOrQuery?.author || info.uploader || '',
        album: target?.primary?.album || info.album || '',
        duration: Number(target?.duration || trackOrQuery?.duration || info.duration || 0) || 0,
        plainLyrics,
        syncedLyrics: '',
        syncedLines: [],
        hasSynced: false,
        __score: 930 + Math.round(q.score * 80),
    };

    // During a parallel provider race we can extract the reliable Arabic body cheaply
    // and defer subtitle probing until this fallback is actually selected. This avoids
    // duplicate caption downloads when a manual subtitle/provider result wins first.
    if (options.skipAdaptiveTiming === true) return result;

    // If YouTube's speech recogniser guessed the *wrong language* but its timestamps
    // still follow the vocals, use only those timestamps as a timing skeleton. The
    // foreign caption text is discarded completely; the visible words stay Arabic.
    try {
        if (config.LYRICS_ARABIC_ADAPTIVE_TIMING === false) return result;
        const skeleton = await tryYouTubeCaptionTimingSkeletonWithInfo(trackOrQuery, info, 'ar');
        if (skeleton?.lines?.length) {
            const aligned = alignPlainLyricsToTimingSkeleton(plainLyrics, skeleton.lines, result.duration);
            if (aligned.length >= 5) {
                result.syncedLines = aligned;
                result.hasSynced = true;
                result.approximateSync = true;
                result.source = 'Source description • Arabic + adaptive timing';
                // Keep the timing-track language only as internal diagnostics. The user-facing
                // Source field must not misleadingly look like Turkish/foreign lyric text.
                result.timingLanguage = skeleton.language || '';
                result.__score += 70;
            }
        }
    } catch (_) {}
    return result;
}

function youtubeSearchQueries(target, preferredLanguage) {
    const out = [];
    const add = q => { q = normalizeSpaces(q); if (q && !out.includes(q)) out.push(q); };
    const pref = langBase(preferredLanguage || 'en');
    const canonicalAnime = extractAnimeMusicIdentities(target.rawTitle || '', target.rawAuthor || '', target.duration || 0);
    const identities = canonicalAnime.length ? dedupeIdentities([...canonicalAnime, ...target.identities.filter(id => !/\b(?:opening|ending|season)\b/i.test(id.title))]) : target.identities;
    for (const id of identities.slice(0, 6)) {
        const artists = lyricArtistVariants(id.artist);
        const core = id.artist ? `${id.artist} ${id.title}` : id.title;
        add(`${core} lyrics`);
        if (pref === 'ja') {
            add(`${core} romaji lyrics`);
            add(`${core} romanized lyrics`);
            add(`${id.title} romaji lyrics`);
            add(`${core} 歌詞`);
        } else if (pref === 'ko') {
            add(`${core} romanized lyrics`);
            add(`${core} romanization lyrics`);
            add(`${id.title} romanized lyrics`);
        } else if (pref === 'zh') {
            add(`${core} pinyin lyrics`);
            add(`${core} romanized lyrics`);
            add(`${id.title} pinyin lyrics`);
        } else {
            add(`${core} english lyrics`);
        }
        add(`${id.title} lyrics`);
        if (pref === 'ar' || hasArabic(`${id.title} ${id.artist}`)) add(`${core} كلمات`);
        if (id.version?.hint) {
            add(`${id.baseTitle} ${id.version.hint} lyrics`);
            add(`${id.baseTitle} ${id.version.hint} 歌詞`);
        }
        for (const a of artists.slice(0, 4)) {
            add(`${a} ${id.title} lyrics`);
            add(`${a} ${id.title} 歌詞`);
            if (id.version?.hint) add(`${a} ${id.baseTitle} ${id.version.hint} lyrics`);
        }
        if (id.version?.altered) {
            add(`${core} official audio`);
            add(core);
        }
    }
    return out.slice(0, Math.min(20, LYRICS_DEEP_QUERY_LIMIT));
}

function arabicYoutubeSearchQueries(target) {
    const out = [];
    const add = q => {
        q = normalizeSpaces(q);
        if (q && !out.includes(q)) out.push(q);
    };
    for (const id of target.identities.slice(0, 8)) {
        if (!id?.title) continue;
        const artists = lyricArtistVariants(id.artist);
        const core = id.artist ? `${id.artist} ${id.title}` : id.title;
        add(`${core} كلمات`);
        add(`${core} كلمات الأغنية`);
        add(`${core} lyrics arabic`);
        add(core);
        if (id.baseTitle && id.baseTitle !== id.title) {
            add(`${id.artist || ''} ${id.baseTitle} كلمات`);
            add(`${id.baseTitle} كلمات`);
        }
        if (id.version?.hint) add(`${id.artist || ''} ${id.baseTitle} ${id.version.hint} كلمات`);
        for (const artist of artists.slice(0, 3)) {
            add(`${artist} ${id.title} كلمات`);
            add(`${artist} ${id.baseTitle || id.title}`);
        }
    }
    return out.slice(0, Math.min(24, Math.max(12, LYRICS_DEEP_QUERY_LIMIT)));
}

function youtubeCandidateScore(candidate, target) {
    const pseudo = { trackName: candidate?.title || '', artistName: candidate?.author || '', duration: Number(candidate?.duration || 0), syncedLyrics: 'x' };
    const lyricTitle = cleanIdentityText(cleanIdentityText(candidate?.title || '')
        .replace(/\b(?:romaji|romanji|romanized|romanised|pinyin)\s+lyrics?\b/gi, ' ')
        .replace(/\blyrics?\s*$/i, ' '));
    const embeddedArtist = splitArtistTitleDeep(lyricTitle, candidate?.author || '');
    // Lyric channels upload "Performer - Song" with their own channel as
    // author. Score the explicit performer identity too before rejecting them.
    const metrics = [candidateMetrics(pseudo, target), candidateMetrics({ ...pseudo,
        trackName: embeddedArtist.title, artistName: embeddedArtist.artist }, target)]
        .sort((a, b) => Number(b.score) - Number(a.score))[0];
    if (!Number.isFinite(metrics.score)) return -Infinity;
    if (!metrics.syncSafe) return -Infinity;
    if (target.altered && metrics.version?.missing && !metrics.durationFit?.close) return -Infinity;
    const titleConfidence = Math.max(Number(metrics.baseSim || 0), Number(metrics.fullSim || 0));
    const strongApproxIdentity = Number(metrics.identityConfidence || 0) >= 0.82
        || (!metrics.artist && titleConfidence >= 0.94 && metrics.durationFit?.close)
        || (Number(metrics.artistSim || 0) >= 0.88 && titleConfidence >= 0.78 && metrics.durationFit?.close);
    if (!strongApproxIdentity) return -Infinity;
    return metrics.score;
}

async function deepYouTubeCaptionSearch(target, preferredLanguage = 'en') {
    let ytDlp;
    try { ytDlp = require('./ytDlpProvider'); } catch (_) { return null; }
    const queries = youtubeSearchQueries(target, preferredLanguage);
    const searches = await runBounded(queries.map(q => async () => withLyricsYtDlpSlot(() => ytDlp.search(q, { limit: 6 }))), Math.min(4, LYRICS_YOUTUBE_PROBE_CONCURRENCY + 1));
    const candidates = [];
    const seen = new Set();
    for (const r of searches) {
        if (r?.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
        for (const item of r.value) {
            const url = String(item?.url || '');
            if (!url || seen.has(url)) continue;
            seen.add(url);
            let score = youtubeCandidateScore(item, target);
            if (!Number.isFinite(score) || score < 330) continue;
            const title = String(item?.title || '').toLowerCase();
            const pref = langBase(preferredLanguage || 'en');
            if (pref === 'ja' && /\b(?:romaji|romanized|romanisation|romanization)\b/i.test(title)) score += 180;
            if (pref === 'ko' && /\b(?:romanized|romanisation|romanization)\b/i.test(title)) score += 180;
            if (pref === 'zh' && /\b(?:pinyin|romanized|romanisation|romanization)\b/i.test(title)) score += 180;
            candidates.push({ item, score });
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    // A burst of empty/ASR lyric uploads must not exhaust discovery before a
    // genuine CJK caption source is inspected. Keep the same global probe limiter.
    const top = candidates.slice(0, CJK_LANGS.has(langBase(preferredLanguage)) ? 28 : 14);
    const probed = await runBounded(top.map(entry => async () => {
        const title = String(entry.item?.title || '');
        const romanizationHint = /\b(?:romaji|romanji|romanized|romanised|romanization|romanisation|pinyin|phonetic|transliteration)\b/i.test(title);
        const info = await fetchTrackMetadata(entry.item);
        if (!info) return null;
        const inspected = {
            ...entry.item,
            title: info.track || info.title || entry.item.title,
            author: info.artist || info.album_artist || entry.item.author,
            duration: Number(info.duration || entry.item.duration || 0),
        };
        const inspectedScore = youtubeCandidateScore(inspected, target);
        if (!Number.isFinite(inspectedScore)) return null;
        const got = await tryYouTubeCaptionsWithInfo(inspected, preferredLanguage, info, { romanizationHint });
        if (!got) return null;
        if (romanizationHint) got.romanizationHint = true;
        got.source = `${got.source.replace(/^YouTube exact captions/, 'YouTube searched captions')} • searched version`;
        got.__score = inspectedScore + 180 + (romanizationHint ? 180 : 0);
        return got;
    }), LYRICS_YOUTUBE_PROBE_CONCURRENCY);
    const good = probed.filter(x => x?.status === 'fulfilled' && x.value?.syncedLines?.length).map(x => x.value);
    good.sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0));
    return good[0] || null;
}

async function deepArabicYouTubeLyricsSearch(target) {
    if (config.LYRICS_ARABIC_YOUTUBE_DEEP_SEARCH === false) return null;
    let ytDlp;
    try { ytDlp = require('./ytDlpProvider'); } catch (_) { return null; }
    const queries = arabicYoutubeSearchQueries(target);
    const searches = await runBounded(
        queries.map(q => async () => withLyricsYtDlpSlot(() => ytDlp.search(q, { limit: 6 }))),
        Math.min(4, LYRICS_YOUTUBE_PROBE_CONCURRENCY),
    );
    const candidates = [];
    const seen = new Set();
    for (const r of searches) {
        if (r?.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
        for (const item of r.value) {
            const url = String(item?.url || '');
            if (!url || seen.has(url)) continue;
            seen.add(url);
            const score = youtubeCandidateScore(item, target);
            if (!Number.isFinite(score) || score < 310) continue;
            candidates.push({ item, score });
        }
    }
    candidates.sort((a, b) => b.score - a.score);

    const topLimit = Math.max(4, Math.min(16, Number(config.LYRICS_ARABIC_YOUTUBE_CANDIDATE_LIMIT || 10)));
    const top = candidates.slice(0, topLimit);
    const inspected = await runBounded(top.map(entry => async () => {
        const info = await fetchTrackMetadata(entry.item);
        if (!info) return null;
        const result = await tryEmbeddedArabicLyrics(entry.item, target, info);
        if (!result || !lyricsLanguageAcceptable(result, 'ar')) return null;
        result.source = `${result.source} • searched version`;
        result.__score = Number(result.__score || 0) + Number(entry.score || 0);
        return result;
    }), Math.min(3, LYRICS_YOUTUBE_PROBE_CONCURRENCY));
    const good = inspected
        .filter(x => x?.status === 'fulfilled' && x.value)
        .map(x => x.value)
        .sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0));
    return good[0] || null;
}

async function deepPlainFallback(target, preferredLanguage = 'en') {
    const candidates = [];
    for (const id of target.identities.slice(0, 3)) {
        if (!id.title || !id.artist) continue;
        try {
            const got = await tryLyricsOvh(id.title, id.artist);
            if (got?.plainLyrics) {
                const metrics = candidateMetrics({ trackName: id.title, artistName: id.artist, duration: 0, plainLyrics: got.plainLyrics }, target);
                got.__score = Number(metrics.score || 0);
                candidates.push(got);
            }
        } catch (_) {}
    }
    candidates.sort((a, b) => Number(b.__score || 0) - Number(a.__score || 0));
    const best = candidates[0] || null;
    // lyrics.ovh does not declare a language. Do not stamp the requested language
    // onto an unknown body: strict English/Arabic/CJK validators must inspect the
    // actual text instead of trusting a synthetic tag.
    return best;
}


function medianNumber(values = []) {
    const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!nums.length) return 0;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function lyricComparable(value = '') {
    return normalizeIdentity(String(value || ''))
        .replace(/\b(?:music|instrumental|applause)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

function bigramDice(a = '', b = '') {
    const aa = lyricComparable(a).replace(/\s+/g, '');
    const bb = lyricComparable(b).replace(/\s+/g, '');
    if (!aa || !bb) return 0;
    if (aa === bb) return 1;
    if (Math.min(aa.length, bb.length) >= 5 && (aa.includes(bb) || bb.includes(aa))) return 0.92;
    if (aa.length < 2 || bb.length < 2) return 0;
    const counts = new Map();
    for (let i = 0; i < aa.length - 1; i++) {
        const g = aa.slice(i, i + 2); counts.set(g, (counts.get(g) || 0) + 1);
    }
    let common = 0;
    for (let i = 0; i < bb.length - 1; i++) {
        const g = bb.slice(i, i + 2); const n = counts.get(g) || 0;
        if (n > 0) { common++; counts.set(g, n - 1); }
    }
    return (2 * common) / Math.max(1, (aa.length - 1) + (bb.length - 1));
}

function shiftSyncedLines(lines = [], seconds = 0) {
    const delta = Number(seconds || 0);
    return (Array.isArray(lines) ? lines : []).map(line => ({
        ...line,
        time: Math.max(0, Number(line?.time || 0) + delta),
        ...(line?.endTime != null && Number.isFinite(Number(line.endTime))
            ? { endTime: Math.max(0, Number(line.endTime) + delta) } : {}),
        ...(Array.isArray(line?.words) ? { words: line.words.map(word => ({ ...word,
            time: Math.max(0, Number(word.time) + delta),
            ...(word.endTime != null && Number.isFinite(Number(word.endTime)) ? { endTime: Math.max(0, Number(word.endTime) + delta) } : {}),
        })) } : {}),
    }));
}

function calibrateSyncedToSkeleton(lines = [], skeleton = [], duration = 0) {
    const src = sanitizeCaptionLines(lines || []);
    const ref = sanitizeCaptionLines(skeleton || []);
    if (src.length < 6 || ref.length < 6) return { lines: src, offset: 0, confidence: 0 };
    const diffs = [];
    const step = Math.max(1, Math.floor(src.length / 28));
    for (let i = 0; i < src.length; i += step) {
        const expected = Math.round(i * (ref.length - 1) / Math.max(1, src.length - 1));
        let best = { score: 0, j: -1 };
        for (let j = Math.max(0, expected - 5); j <= Math.min(ref.length - 1, expected + 5); j++) {
            const score = bigramDice(src[i]?.text, ref[j]?.text);
            if (score > best.score) best = { score, j };
        }
        if (best.score >= 0.57 && best.j >= 0) diffs.push(Number(ref[best.j].time || 0) - Number(src[i].time || 0));
    }
    let offset = 0;
    let confidence = 0;
    if (diffs.length >= 3) {
        offset = medianNumber(diffs);
        const mad = medianNumber(diffs.map(x => Math.abs(x - offset)));
        if (mad <= 0.85) confidence = Math.min(1, 0.55 + diffs.length / 18);
    }
    // A similar line count/span does not establish lyric correspondence. Foreign
    // ASR and unrelated subtitles can have the same density. Only matching sung
    // words may calibrate provider timings; transliteration preserves their times.
    if (!Number.isFinite(offset) || Math.abs(offset) < 0.08 || Math.abs(offset) > 3.2 || confidence < 0.55) {
        return { lines: src, offset: 0, confidence: 0 };
    }
    const shifted = shiftSyncedLines(src, offset);
    if (duration > 0 && shifted.length && Number(shifted[shifted.length - 1].time || 0) > duration + 3) {
        return { lines: src, offset: 0, confidence: 0 };
    }
    return { lines: shifted, offset, confidence };
}

function synthesizePlainTimings(plainLyrics = '', duration = 0) {
    let lines = String(plainLyrics || '').split(/\r?\n/).map(normalizeSpaces)
        .filter(line => line && !/^\[[^\]]+\]$/.test(line));
    // Some Arabic plain providers return one paragraph. Segment only the display
    // estimate into short phrases; keep the original lyric body and every word.
    if (lines.length < 4 && arabicLyricsQuality(lines.join('\n')).score >= 0.58) {
        const wordCount = lines.join(' ').split(/\s+/).length;
        if (wordCount >= 24) lines = lines.flatMap(line => {
            const words = line.split(/\s+/), phrases = [];
            for (let i = 0; i < words.length; i += 6) phrases.push(words.slice(i, i + 6).join(' '));
            return phrases;
        });
    }
    const totalDuration = Math.max(0, Number(duration || 0));
    if (lines.length < 4 || totalDuration < 35) return [];
    const intro = Math.min(12, Math.max(2.2, Number(config.LYRICS_ESTIMATED_INTRO_SEC || 4.5), totalDuration * 0.018));
    const outro = Math.min(12, Math.max(2.5, Number(config.LYRICS_ESTIMATED_OUTRO_SEC || 5), totalDuration * 0.018));
    const usable = Math.max(15, totalDuration - intro - outro);
    const weights = lines.map(line => {
        const p = scriptProfile(line);
        const wordCount = (line.match(/\S+/g) || []).length;
        const chars = p.arabic + p.latin + p.kana + p.han + p.hangul;
        return Math.max(1.5, Math.sqrt(Math.max(1, chars)) + wordCount * 0.75);
    });
    const total = weights.reduce((a, b) => a + b, 0) || lines.length;
    let cursor = intro;
    return lines.map((text, i) => {
        const time = Math.min(totalDuration - 0.25, cursor);
        cursor += usable * (weights[i] / total);
        return { time: Math.max(0, time), text };
    });
}

function extractRomanizedDescriptionLyrics(description = '') {
    const lines = String(description || '').split(/\r?\n/);
    let best = [], current = [];
    const flush = () => { if (current.length > best.length) best = current.slice(); current = []; };
    for (const raw of lines) {
        const line = normalizeSpaces(raw.replace(/^[-•*>#]+\s*/, ''));
        if (!line) { if (current.length >= 3) flush(); else current = []; continue; }
        if (/https?:\/\/|(?:subscribe|follow|instagram|twitter|spotify|apple music|copyright|credits?|channel|official video)/i.test(line)) { flush(); continue; }
        const p = scriptProfile(line);
        const acceptable = p.latin >= 3 && p.latinRatio >= 0.72 && p.arabic === 0 && p.kana === 0 && p.han === 0 && p.hangul === 0 && line.length <= 220;
        if (acceptable) current.push(line); else if (current.length >= 3) flush(); else current = [];
    }
    flush();
    const text = best.join('\n');
    return best.length >= 5 && text.length >= 80 ? text : '';
}

async function deepCjkRomanizedDescriptionSearch(target, preferredLanguage, timingLines = []) {
    if (config.LYRICS_CJK_DESCRIPTION_ROMANIZATION === false) return null;
    const pref = langBase(preferredLanguage || '');
    if (!CJK_LANGS.has(pref)) return null;
    let ytDlp;
    try { ytDlp = require('./ytDlpProvider'); } catch (_) { return null; }
    const queries = youtubeSearchQueries(target, pref).filter(q => /\b(?:romaji|romanized|romanisation|romanization|pinyin)\b/i.test(q)).slice(0, 6);
    for (const query of queries) {
        let results = [];
        try { results = await withLyricsYtDlpSlot(() => ytDlp.search(query, { limit: 4 })); } catch (_) { results = []; }
        for (const candidate of results.slice(0, 3)) {
            const candidateLabel = `${candidate?.title || ''} ${candidate?.author || ''}`;
            if (!ROMANIZATION_HINT_RE.test(candidateLabel)) continue;
            let info = null;
            try { info = await fetchTrackMetadata(candidate); } catch (_) { info = null; }
            const sourceIdentity = makeTargetIdentity(info?.track || info?.title || candidate?.title || '', info?.artist || info?.album_artist || candidate?.author || '', Number(info?.duration || candidate?.duration || 0));
            const metrics = candidateMetrics({ trackName: sourceIdentity.title, artistName: sourceIdentity.artist, duration: sourceIdentity.duration }, target);
            // A Romaji/Pinyin label describes a format, not song identity. Never
            // relabel the first romanized description as the playing song.
            if (!Number.isFinite(metrics.score) || Number(metrics.identityConfidence || 0) < 0.84) continue;
            const plainLyrics = extractRomanizedDescriptionLyrics(info?.description || '');
            if (!plainLyrics) continue;
            const bodyProfile = scriptProfile(plainLyrics);
            if (bodyProfile.latinRatio < 0.72) continue;
            const pronunciationEvidence = cjkRomanizationEvidence(plainLyrics, pref, null);
            const looksLikeEnglishTranslation = englishLyricsQuality(plainLyrics, '') >= 0.82;
            if (pronunciationEvidence <= 0 && looksLikeEnglishTranslation) continue;
            let syncedLines = [];
            if (Array.isArray(timingLines) && timingLines.length >= 5) {
                syncedLines = alignPlainLyricsToTimingSkeleton(plainLyrics, timingLines, Number(target?.duration || 0));
            }
            if (!syncedLines.length && candidate?.url) {
                try {
                    const skeleton = await tryYouTubeCaptionTimingSkeletonWithInfo(candidate, info, pref);
                    if (skeleton?.lines?.length) syncedLines = alignPlainLyricsToTimingSkeleton(plainLyrics, skeleton.lines, Number(target?.duration || candidate?.duration || 0));
                } catch (_) {}
            }
            return {
                source: `YouTube ${pref === 'ja' ? 'Romaji' : pref === 'zh' ? 'Pinyin' : 'Romanized'} description${syncedLines.length ? ' + synced timing' : ''}`,
                language: pref,
                title: target?.primary?.title || candidate?.title || '',
                artist: target?.primary?.artist || candidate?.author || '',
                duration: Number(target?.duration || candidate?.duration || 0) || 0,
                plainLyrics,
                syncedLines,
                syncedLyrics: '',
                hasSynced: syncedLines.length > 0,
                romanizationHint: true,
                approximateSync: syncedLines.length > 0,
                __score: 1010,
            };
        }
    }
    return null;
}

let japaneseTokenizerPromise = null;
let koreanRomanizer = null;
const romanizedTextCache = new Map();

function hasNativeCjkText(text, language) {
    return language === 'ja' ? /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)
        : language === 'ko' ? /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(text)
            : /\p{Script=Han}/u.test(text);
}

async function getJapaneseTokenizer() {
    if (!japaneseTokenizerPromise) {
        japaneseTokenizerPromise = new Promise((resolve, reject) => {
            try {
                const path = require('node:path');
                const kuromoji = require('kuromoji');
                const dicPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
                kuromoji.builder({ dicPath }).build((error, tokenizer) => error ? reject(error) : resolve(tokenizer));
            } catch (error) { reject(error); }
        });
        // A missing/corrupt dictionary should retain native lyrics, not poison all
        // future lyric lookups. Loading is shared by simultaneous Japanese requests.
        japaneseTokenizerPromise.catch(() => { japaneseTokenizerPromise = null; });
    }
    return japaneseTokenizerPromise;
}

const KANA_ROMAJI = Object.assign(Object.create(null), {
    'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo', 'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
    'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho', 'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
    'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho', 'ぢゃ': 'ja', 'ぢゅ': 'ju', 'ぢょ': 'jo',
    'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo', 'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
    'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo', 'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
    'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo', 'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
    'いぇ': 'ye', 'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'wo', 'しぇ': 'she', 'じぇ': 'je', 'ちぇ': 'che',
    'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo', 'ふゅ': 'fyu',
    'てぃ': 'ti', 'てゅ': 'tyu', 'とぅ': 'tu', 'でぃ': 'di', 'でゅ': 'dyu', 'どぅ': 'du',
    'つぁ': 'tsa', 'つぃ': 'tsi', 'つぇ': 'tse', 'つぉ': 'tso',
    'くぁ': 'kwa', 'くぃ': 'kwi', 'くぇ': 'kwe', 'くぉ': 'kwo',
    'ぐぁ': 'gwa', 'ぐぃ': 'gwi', 'ぐぇ': 'gwe', 'ぐぉ': 'gwo',
    'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo', 'ゔゅ': 'vyu',
});
for (const [kana, syllables] of [
    ['あいうえお', 'a i u e o'], ['かきくけこ', 'ka ki ku ke ko'], ['がぎぐげご', 'ga gi gu ge go'],
    ['さしすせそ', 'sa shi su se so'], ['ざじずぜぞ', 'za ji zu ze zo'], ['たちつてと', 'ta chi tsu te to'],
    ['だぢづでど', 'da ji zu de do'], ['なにぬねの', 'na ni nu ne no'], ['はひふへほ', 'ha hi fu he ho'],
    ['ばびぶべぼ', 'ba bi bu be bo'], ['ぱぴぷぺぽ', 'pa pi pu pe po'], ['まみむめも', 'ma mi mu me mo'],
    ['やゆよ', 'ya yu yo'], ['らりるれろ', 'ra ri ru re ro'], ['わゐゑを', 'wa wi we o'],
    ['ぁぃぅぇぉゃゅょゎゕゖゔ', 'a i u e o ya yu yo wa ka ke vu'],
]) {
    const values = syllables.split(' ');
    [...kana].forEach((character, index) => { KANA_ROMAJI[character] = values[index]; });
}

function kanaToHepburn(value = '') {
    const kana = String(value).normalize('NFKC').replace(/[ァ-ヶ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60));
    let out = '', geminate = false;
    for (let i = 0; i < kana.length; i++) {
        const current = kana[i];
        if (current === 'っ') { geminate = true; continue; }
        if (current === 'ー') { out += out.match(/[aeiou](?!.*[aeiou])/)?.[0] || ''; continue; }
        if (current === 'ん') {
            const following = KANA_ROMAJI[kana.slice(i + 1, i + 3)] || KANA_ROMAJI[kana[i + 1]] || '';
            out += /^[aeiouy]/.test(following) ? "n'" : 'n';
            continue;
        }
        let syllable = KANA_ROMAJI[kana.slice(i, i + 2)];
        if (syllable) i++;
        else syllable = KANA_ROMAJI[current] || current;
        if (geminate && /^[a-z]/.test(syllable)) out += syllable.startsWith('ch') ? 't' : syllable[0];
        geminate = false;
        out += syllable;
    }
    return out;
}

function romanizationAvailable(language) {
    try {
        require.resolve(language === 'ja' ? 'kuromoji' : language === 'zh' ? 'pinyin-pro' : 'aromanize/base');
        return true;
    } catch (_) { return false; }
}

async function romanizeLyricText(value, language, tokenizer = null) {
    const text = String(value || '');
    if (!hasNativeCjkText(text, language)) return text;
    const key = `${language}|${text}`;
    if (romanizedTextCache.has(key)) return romanizedTextCache.get(key);
    let converted;
    if (language === 'ja') {
        tokenizer ||= await getJapaneseTokenizer();
        const tokens = tokenizer.tokenize(text);
        const parts = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const surface = token.surface_form || '';
            // Dictionary pronunciation handles grammatical は/へ and long vowels.
            // Unknown kanji remain visible instead of inventing their reading.
            let reading = token.pronunciation || token.reading || surface;
            // IPADIC can split 歌っ + て. Convert that reading together so the
            // small っ doubles the next consonant instead of disappearing.
            while (/[っッ]$/.test(reading) && i + 1 < tokens.length) {
                const next = tokens[i + 1];
                const nextReading = next.pronunciation || next.reading || next.surface_form || '';
                if (!/^[\u3040-\u30ff]/u.test(nextReading)) break;
                reading += nextReading;
                i++;
            }
            parts.push(hasNativeCjkText(reading, 'ja') ? kanaToHepburn(reading) : surface);
        }
        converted = parts.join(' ');
    } else if (language === 'zh') {
        const { pinyin } = require('pinyin-pro');
        converted = text.replace(/\p{Script=Han}+/gu, body => ` ${pinyin(body, { toneType: 'none' })} `);
    } else {
        if (!koreanRomanizer) {
            const aromanize = require('aromanize/base');
            const rr = aromanize.rules.hangul.rr;
            // The package supplies assimilation/liaison but omits palatalization
            // (같이 -> gachi) and writes ㅢ as eui. Use a private corrected rule
            // table following NIKL RR; do not mutate another consumer's rules.
            koreanRomanizer = {
                ...aromanize,
                rules: { ...aromanize.rules, hangul: { ...aromanize.rules.hangul, 'lyrics-rr': {
                    ...rr,
                    jung: { ...rr.jung, 'ᅴ': 'ui' },
                    jong: {
                        ...rr.jong, 'ᆮ이': 'j', 'ᇀ이': 'ch', 'ᆴ이': 'lch', 'ᆮ히': 'ch',
                        'ᆭᄋ': 'n', 'ᆶᄋ': 'r', 'ᇂᄋ': '', 'ᇂᄀ': 'k', 'ᇂᄃ': 't', 'ᇂᄌ': 'ch',
                    },
                } } },
            };
        }
        converted = koreanRomanizer.hangulToLatin(text.normalize('NFC'), 'lyrics-rr');
    }
    converted = normalizeSpaces(converted).replace(/\s+([,.;:!?、。！，？；：])/g, '$1');
    romanizedTextCache.set(key, converted);
    while (romanizedTextCache.size > 1800) romanizedTextCache.delete(romanizedTextCache.keys().next().value);
    return converted;
}

async function romanizeNativeLyrics(result, language) {
    if (!result || !CJK_LANGS.has(language) || !romanizationAvailable(language)) return false;
    const nativeText = lyricsTextFromResult(result);
    if (!hasNativeCjkText(nativeText, language)) return false;
    const tokenizer = language === 'ja' ? await getJapaneseTokenizer() : null;
    const nativeSyncedLines = (result.syncedLines || []).map(line => ({ ...line }));
    const nativePlainLyrics = String(result.plainLyrics || nativeSyncedLines.map(line => line.text).join('\n'));
    const convertedLines = [];
    for (let i = 0; i < nativeSyncedLines.length; i++) {
        if (i > 0 && i % 12 === 0) await new Promise(resolve => setImmediate(resolve));
        const line = nativeSyncedLines[i];
        const converted = { ...line, text: await romanizeLyricText(line.text, language, tokenizer) };
        if (Array.isArray(line.words) && line.words.length) {
            // Keep the full-line contextual pronunciation authoritative. A segment
            // reading is usable only when it maps exactly back into that reading;
            // otherwise retain its native provenance and let the display estimate.
            delete converted.words;
            delete converted.wordTimingMode;
            const words = [];
            for (const word of line.words) words.push({ ...word, text: await romanizeLyricText(word.text, language, tokenizer) });
            attachProviderWordTimes(converted, words);
        }
        convertedLines.push(converted);
    }
    const plainLines = [];
    for (const line of nativePlainLyrics.split('\n')) plainLines.push(await romanizeLyricText(line, language, tokenizer));
    const plainLyrics = plainLines.join('\n');
    const complete = !hasNativeCjkText(`${convertedLines.map(line => line.text).join('\n')}\n${plainLyrics}`, language);
    result.nativeSyncedLines = nativeSyncedLines;
    result.nativePlainLyrics = nativePlainLyrics;
    result.syncedLines = convertedLines;
    result.plainLyrics = plainLyrics;
    result.romanized = complete;
    result.romanizationHint = true;
    result.romanizationStatus = complete ? 'complete' : 'partial';
    result.romanizationMethod = language === 'ja' ? 'Hepburn (dictionary pronunciation)' : language === 'zh' ? 'Mandarin Pinyin (contextual reading)' : 'Revised Romanization (pronunciation)';
    result.romanizationSource = language === 'ja' ? 'kuromoji/IPADIC' : language === 'zh' ? 'pinyin-pro' : 'aromanize';
    if (!complete) result.needsUpgrade = true;
    return complete;
}

function annotateLyricsProvenance(result, preferredLanguage) {
    const hasSynced = Boolean(result.syncedLines?.length);
    result.hasSynced = hasSynced;
    result.timingMode = hasSynced
        ? (result.estimatedSync ? 'estimated' : result.approximateSync ? 'adaptive' : 'synced')
        : 'plain';
    result.timingSource = hasSynced
        ? (result.estimatedSync ? 'duration-estimate' : result.approximateSync ? 'caption-alignment'
            : /YouTube exact captions/i.test(String(result.source || '')) && !/searched version/i.test(String(result.source || '')) ? 'exact-upload' : 'provider')
        : '';
    const timedWordLines = (result.syncedLines || []).filter(line => line.words?.length);
    const providerWordLines = timedWordLines.filter(line => line.wordTimingMode === 'provider'
        && line.words.every(word => !/\s/u.test(String(word.text || '')) && Number(word.endTime) > Number(word.time))).length;
    result.wordTimingMode = hasSynced ? providerWordLines === result.syncedLines.length ? 'provider' : timedWordLines.length ? 'mixed' : 'estimated' : '';
    // No source here supplies phoneme/letter clocks. Interpolation within a
    // provider word interval is visual smoothing, not measured letter timing.
    result.letterTimingMode = hasSynced ? 'estimated' : '';
    if (prefersRomanizedLyrics(preferredLanguage) && resultIsRomanized(result, preferredLanguage)
        && !hasNativeCjkText(lyricsTextFromResult(result), preferredLanguage)) {
        result.romanized = true;
        result.romanizationStatus ||= 'provider';
        result.romanizationSource ||= result.source || 'provider';
        result.romanizationMethod ||= preferredLanguage === 'ja' ? 'Provider Romaji'
            : preferredLanguage === 'zh' ? 'Provider Pinyin' : 'Provider Romanization';
    }
    return result;
}

const lyricsPostProcessing = new WeakMap();

async function postProcessLyricsResult(trackOrQuery, result, preferredLanguage) {
    if (!result || result.__postProcessedV638) return result;
    const pending = lyricsPostProcessing.get(result);
    if (pending) return pending;
    // findLyricsUncached caches provider objects before asynchronous processing.
    // Another request must await that object's actual completion instead of
    // observing a prematurely marked native/plain intermediate result.
    const request = postProcessLyricsResultUncached(trackOrQuery, result, preferredLanguage)
        .then(processed => {
            Object.defineProperty(processed, '__postProcessedV638', { value: true, configurable: true, enumerable: false, writable: true });
            return processed;
        })
        .finally(() => lyricsPostProcessing.delete(result));
    lyricsPostProcessing.set(result, request);
    return request;
}

async function postProcessLyricsResultUncached(trackOrQuery, result, preferredLanguage) {
    const isTrack = typeof trackOrQuery !== 'string' && Boolean(trackOrQuery);
    let info = null;
    if (isTrack) {
        try { info = await fetchTrackMetadata(trackOrQuery); } catch (_) { info = null; }
    }
    // The initial title guess may be English while source metadata identifies a
    // Japanese song with a Latin title. Carry the resolver's actual language forward.
    const pref = langBase(inferPreferredLanguage(trackOrQuery, info, result.language || preferredLanguage || 'en'));
    const duration = [trackOrQuery?.duration, result.duration, info?.duration]
        .map(Number).find(value => Number.isFinite(value) && value > 0) || 0;
    if (!(Number(result.duration) > 0) && duration > 0) result.duration = duration;
    result.language = pref || result.language || preferredLanguage || 'en';
    result.timingMode = result.syncedLines?.length
        ? (result.estimatedSync ? 'estimated' : result.approximateSync ? 'adaptive' : 'synced')
        : 'plain';

    // For CJK, do not give up at native-script LRCLIB if a Romanized/Pinyin lyric
    // body exists in a dedicated lyric upload. Reuse the already-correct native
    // timestamps as the skeleton, so pronunciation-friendly text still follows audio.
    if (isTrack && CJK_LANGS.has(pref) && prefersRomanizedLyrics(pref) && !resultIsRomanized(result, pref)) {
        let directlyRomanized = false;
        try { directlyRomanized = await romanizeNativeLyrics(result, pref); } catch (_) { result.romanizationStatus = 'unavailable'; }
        // A partial local reading still has the verified lyric body and exact cue
        // times. Keep unknown characters visible; a guessed description alignment
        // must not downgrade that source or discard its native provenance.
        if (!directlyRomanized && result.romanizationStatus !== 'partial') {
            try {
                const target = buildTargetContext(trackOrQuery, info);
                const romanized = await deepCjkRomanizedDescriptionSearch(target, pref, result.syncedLines || []);
                if (romanized?.plainLyrics && lyricsLanguageAcceptable(romanized, pref)) {
                    // Mutate the cached result object rather than replacing the local
                    // reference. findLyricsUncached caches before post-processing; replacing
                    // only the local variable would make the next lookup fall back to the
                    // old native-script result again.
                    for (const key of Object.keys(result)) delete result[key];
                    Object.assign(result, romanized);
                }
            } catch (_) {}
            if (!resultIsRomanized(result, pref)) result.needsUpgrade = true;
        }
    }

    if (!isTrack) return annotateLyricsProvenance(result, pref);

    // Calibrate database/provider timestamps against the exact playing upload. This
    // removes the common 0.3-1.5s intro/upload bias without a global magic offset.
    if (config.LYRICS_EXACT_TIMING_CALIBRATION !== false && result?.syncedLines?.length >= 6 && !/YouTube exact captions/i.test(String(result.source || ''))) {
        try {
            const skeleton = await tryYouTubeCaptionTimingSkeletonWithInfo(trackOrQuery, info, pref || 'en');
            if (skeleton?.lines?.length >= 6) {
                const nativeLines = result.nativeSyncedLines?.length === result.syncedLines.length ? result.nativeSyncedLines : null;
                // Compare the original sung words with native captions. Latin
                // transliteration cannot establish text correspondence to kanji,
                // Hangul or Han; both display forms still share one corrected clock.
                const calibrated = calibrateSyncedToSkeleton(nativeLines || result.syncedLines, skeleton.lines, duration);
                if (calibrated.confidence >= 0.55 && Math.abs(calibrated.offset) >= 0.08) {
                    result.syncedLines = nativeLines ? shiftSyncedLines(result.syncedLines, calibrated.offset) : calibrated.lines;
                    if (nativeLines) result.nativeSyncedLines = calibrated.lines;
                    result.timingOffsetMs = Math.round(calibrated.offset * 1000);
                    result.timingCalibrated = true;
                }
            }
        } catch (_) {}
    }

    // Plain lyrics must not leave Auto/Live Lyrics dead. Prefer real timing from the
    // exact upload; if none exists, create a conservative weighted timeline as a last
    // resort when enough text and a usable duration exist. Provider retries continue
    // while the UI follows the explicitly labeled estimate.
    if (config.LYRICS_PLAIN_TIMING_FALLBACK !== false && !result?.syncedLines?.length && result?.plainLyrics) {
        let synced = [];
        try {
            const skeleton = await tryYouTubeCaptionTimingSkeletonWithInfo(trackOrQuery, info, pref || 'en');
            if (skeleton?.lines?.length) synced = alignPlainLyricsToTimingSkeleton(result.plainLyrics, skeleton.lines, duration);
        } catch (_) {}
        if (synced.length >= 4) {
            result.syncedLines = synced;
            result.hasSynced = true;
            result.approximateSync = true;
            result.needsUpgrade = true;
            result.timingMode = 'adaptive';
            result.source = `${result.source || 'Lyrics'} • adaptive sync`;
        } else if (duration > 0) {
            synced = synthesizePlainTimings(result.plainLyrics, duration);
            if (synced.length >= 4) {
                result.syncedLines = synced;
                result.hasSynced = true;
                result.approximateSync = true;
                result.estimatedSync = true;
                result.needsUpgrade = true;
                result.timingMode = 'estimated';
                result.source = `${result.source || 'Lyrics'} • estimated sync`;
            }
        }
    }
    return annotateLyricsProvenance(result, pref);
}

const lyricsInflight = new Map();
function findLyrics(trackOrQuery, options = {}) {
    const rawTitle = typeof trackOrQuery === 'string' ? trackOrQuery : (trackOrQuery?.title || '');
    const rawAuthor = typeof trackOrQuery === 'string' ? '' : (trackOrQuery?.author || '');
    const duration = typeof trackOrQuery === 'string' ? 0 : Number(trackOrQuery?.duration || 0);
    const languageIdentity = typeof trackOrQuery === 'string'
        ? rawTitle
        : [trackOrQuery?.mediaTitle, trackOrQuery?.mediaArtist, trackOrQuery?.linkedTitle, trackOrQuery?.linkedArtist, rawTitle, rawAuthor].filter(Boolean).join(' ');
    const language = options.language || guessLyricsLanguage(languageIdentity, rawAuthor);
    const forceRefresh = options.forceRefresh === true;
    // Forced retries use their own in-flight lane: a previous ordinary lookup may
    // currently be resolving to an empty cached miss, and joining it would make a
    // user-visible retry pointless.
    // Normalize human metadata case-insensitively, but preserve the URL byte-for-byte:
    // SoundCloud secret_token and signed query values can be case-sensitive.
    const key = hashKey(`${String(language || '').toLowerCase()}|${normalizeIdentity(rawTitle)}|${normalizeIdentity(rawAuthor)}|${Math.round(duration || 0)}|${String(trackOrQuery?.url || '')}|force=${forceRefresh ? 1 : 0}`);
    if (lyricsInflight.has(key)) return lyricsInflight.get(key);
    const request = findLyricsUncached(trackOrQuery, { ...options, language, forceRefresh })
        .then(result => postProcessLyricsResult(trackOrQuery, result, language))
        .finally(() => lyricsInflight.delete(key));
    lyricsInflight.set(key, request);
    return request;
}

async function findLyricsUncached(trackOrQuery, options = {}) {
    const rawTitle = typeof trackOrQuery === 'string' ? trackOrQuery : (trackOrQuery?.title || '');
    const rawAuthor = typeof trackOrQuery === 'string' ? '' : (trackOrQuery?.author || '');
    let preferredLanguage = options.language || guessLyricsLanguage(rawTitle, rawAuthor);
    const info = await fetchTrackMetadata(trackOrQuery);
    preferredLanguage = inferPreferredLanguage(trackOrQuery, info, preferredLanguage);
    const target = buildTargetContext(trackOrQuery, info);
    const cacheIdentity = target.identities.map(x => `${normalizeIdentity(x.title)}|${normalizeIdentity(x.artist)}|${normalizeIdentity(x.album)}`).join('||');
    // Synced captions from the exact playing upload can carry source-specific intro/
    // outro timing. Keep the URL in the resolved-lyrics cache identity so another
    // upload of the same song/remix cannot inherit those timestamps.
    const sourceIdentity = typeof trackOrQuery === 'string' ? '' : String(trackOrQuery?.url || '');
    const cacheKey = hashKey(`${preferredLanguage}|${cacheIdentity}|${Math.round(target.duration || 0)}|${sourceIdentity}`);
    const cached = cache.get(cacheKey);
    if (cached) {
        const hasSyncedResult = Boolean((cached.value?.syncedLines || []).length);
        const hasReliableSyncedResult = hasSyncedResult && !cached.value?.approximateSync && !cached.value?.estimatedSync && !cached.value?.needsUpgrade;
        const isEmptyResult = !cached.value?.plainLyrics && !hasSyncedResult;
        const ttl = isEmptyResult ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS;
        // A forced refresh is specifically allowed to retry an empty OR plain-only
        // result in search of synchronized timings. Already-synced lyrics remain
        // hot and reusable, preventing provider hammering once we have the ideal result.
        if (Date.now() - cached.at < ttl && !(options.forceRefresh === true && !hasReliableSyncedResult)) {
            cache.delete(cacheKey); cache.set(cacheKey, cached); return cached.value;
        }
        cache.delete(cacheKey);
    }

    let lastError = null;
    const validLanguage = result => Boolean(result && lyricsLanguageAcceptable(result, preferredLanguage));
    const arabicMode = langBase(preferredLanguage) === 'ar';
    const romanizedPreferred = prefersRomanizedLyrics(preferredLanguage);
    let nativeCjkFallback = null;
    const keepOrReturnCjk = result => {
        if (!result || !validLanguage(result)) return { returnNow: false, result: null };
        if (!romanizedPreferred || resultIsRomanized(result, preferredLanguage)) return { returnNow: true, result };
        // A local pronunciation dictionary can convert this exact lyric body
        // without changing any cue times or searching another song upload.
        if (hasNativeCjkText(lyricsTextFromResult(result), langBase(preferredLanguage)) && romanizationAvailable(langBase(preferredLanguage))) {
            return { returnNow: true, result };
        }
        if (!nativeCjkFallback || Number(result.__score || 0) > Number(nativeCjkFallback.__score || 0)) nativeCjkFallback = result;
        return { returnNow: false, result };
    };

    // For remixes/edits/slowed/live versions, captions attached to the exact playing video
    // are the strongest possible timing evidence. Try them before any database timings.
    if (target.altered && typeof trackOrQuery !== 'string' && trackOrQuery?.url) {
        try {
            // Arabic auto-ASR can be visibly wrong even when timing is excellent.
            // Before databases, trust only a human/manual Arabic subtitle track.
            const exactCaptions = await tryYouTubeCaptionsWithInfo(
                trackOrQuery,
                preferredLanguage,
                info,
                arabicMode ? { manualOnly: true } : {},
            );
            if (exactCaptions && validLanguage(exactCaptions)) {
                const decision = keepOrReturnCjk(exactCaptions);
                if (decision.returnNow) {
                    cacheSet(cacheKey, exactCaptions);
                    return exactCaptions;
                }
            }
        } catch (err) { lastError = err; }
    }

    // Query LRCLIB aggressively with exact, structured and broad variants in parallel.
    let lrclibResults = [];
    try { lrclibResults = await deepLrclibSearch(target, preferredLanguage); } catch (err) { lastError = err; }
    const bestSynced = pickBestLanguageResult(lrclibResults, preferredLanguage, { syncedOnly: true });
    if (bestSynced) {
        bestSynced.language = preferredLanguage;
        const decision = keepOrReturnCjk(bestSynced);
        if (decision.returnNow) {
            cacheSet(cacheKey, bestSynced);
            return bestSynced;
        }
    }

    // After LRCLIB misses, Arabic mode fans out the independent *bounded* secondary
    // lookups together. This is materially faster for rare Arabic tracks than waiting
    // Karalyr -> lrcmux -> exact manual captions -> source description serially, while
    // the global HTTP/yt-dlp semaphores still prevent lyric discovery from competing
    // with the realtime audio pipeline.
    let karalyrResults = [];
    let lrcMuxResults = [];

    if (arabicMode) {
        const canTryExactManual = !target.altered && typeof trackOrQuery !== 'string' && Boolean(trackOrQuery?.url);
        const canTryEmbedded = Boolean(info && typeof trackOrQuery !== 'string');
        const jobs = [
            deepKaralyrSearch(target, preferredLanguage),
            deepLrcMuxSearch(target),
            canTryExactManual
                ? tryYouTubeCaptionsWithInfo(trackOrQuery, preferredLanguage, info, { manualOnly: true })
                : Promise.resolve(null),
            canTryEmbedded
                ? tryEmbeddedArabicLyrics(trackOrQuery, target, info, { skipAdaptiveTiming: true })
                : Promise.resolve(null),
        ];
        const settled = await Promise.allSettled(jobs);
        if (settled[0].status === 'fulfilled') karalyrResults = Array.isArray(settled[0].value) ? settled[0].value : [];
        else lastError = settled[0].reason || lastError;
        if (settled[1].status === 'fulfilled') lrcMuxResults = Array.isArray(settled[1].value) ? settled[1].value : [];
        else lastError = settled[1].reason || lastError;
        const exactManual = settled[2].status === 'fulfilled' ? settled[2].value : null;
        if (settled[2].status === 'rejected') lastError = settled[2].reason || lastError;
        const embeddedArabic = settled[3].status === 'fulfilled' ? settled[3].value : null;
        if (settled[3].status === 'rejected') lastError = settled[3].reason || lastError;

        // Exact human subtitles attached to the audible upload are the strongest timing
        // evidence. Provider-synced lyrics follow; source-description lyrics are next.
        const bestKaralyrSynced = pickBestLanguageResult(karalyrResults, preferredLanguage, { syncedOnly: true });
        const bestLrcMuxSynced = pickBestLanguageResult(lrcMuxResults, preferredLanguage, { syncedOnly: true });
        const immediateWinner = (exactManual && validLanguage(exactManual) ? exactManual : null)
            || bestKaralyrSynced
            || bestLrcMuxSynced;
        if (immediateWinner) {
            immediateWinner.language = preferredLanguage;
            cacheSet(cacheKey, immediateWinner);
            return immediateWinner;
        }
        if (embeddedArabic && validLanguage(embeddedArabic)) {
            let enrichedEmbedded = embeddedArabic;
            try {
                // Only now pay the cost of probing a caption timing skeleton.
                enrichedEmbedded = await tryEmbeddedArabicLyrics(trackOrQuery, target, info) || embeddedArabic;
            } catch (err) { lastError = err; }
            enrichedEmbedded.language = preferredLanguage;
            cacheSet(cacheKey, enrichedEmbedded);
            return enrichedEmbedded;
        }
    } else {
        // Non-Arabic tracks retain the staged provider ordering that has proven stable.
        // These calls are still internally bounded and stop as soon as a strong sync wins.
        try { karalyrResults = await deepKaralyrSearch(target, preferredLanguage); } catch (err) { lastError = err; }
        const bestKaralyrSynced = pickBestLanguageResult(karalyrResults, preferredLanguage, { syncedOnly: true });
        if (bestKaralyrSynced) {
            bestKaralyrSynced.language = preferredLanguage;
            const decision = keepOrReturnCjk(bestKaralyrSynced);
            if (decision.returnNow) {
                cacheSet(cacheKey, bestKaralyrSynced);
                return bestKaralyrSynced;
            }
        }

        try { lrcMuxResults = await deepLrcMuxSearch(target); } catch (err) { lastError = err; }
        const bestLrcMuxSynced = pickBestLanguageResult(lrcMuxResults, preferredLanguage, { syncedOnly: true });
        if (bestLrcMuxSynced) {
            bestLrcMuxSynced.language = preferredLanguage;
            const decision = keepOrReturnCjk(bestLrcMuxSynced);
            if (decision.returnNow) {
                cacheSet(cacheKey, bestLrcMuxSynced);
                return bestLrcMuxSynced;
            }
        }

        // The current upload may still have correct captions for normal versions too.
        if (!target.altered && typeof trackOrQuery !== 'string' && trackOrQuery?.url) {
            try {
                const exactCaptions = await tryYouTubeCaptionsWithInfo(trackOrQuery, preferredLanguage, info);
                if (exactCaptions && validLanguage(exactCaptions)) {
                    const decision = keepOrReturnCjk(exactCaptions);
                    if (decision.returnNow) {
                        cacheSet(cacheKey, exactCaptions);
                        return exactCaptions;
                    }
                }
            } catch (err) { lastError = err; }
        }
    }

    // Only after reliable database/manual/description paths have failed do we let
    // Arabic automatic captions become visible lyric text. They still have to pass
    // the Arabic-script validator and machine-translation guard.
    if (arabicMode && typeof trackOrQuery !== 'string' && trackOrQuery?.url) {
        try {
            const autoCaptions = await tryYouTubeCaptionsWithInfo(trackOrQuery, preferredLanguage, info, { autoOnly: true });
            if (autoCaptions && validLanguage(autoCaptions)) {
                cacheSet(cacheKey, autoCaptions);
                return autoCaptions;
            }
        } catch (err) { lastError = err; }
    }

    // For links coming from SoundCloud/Spotify/TIDAL (or Arabic YouTube uploads with
    // poor captions), search matching YouTube versions for an Arabic lyric body in the
    // official/near-exact description. This expands coverage without scraping arbitrary
    // lyric websites and keeps the source identity/version scorer in control.
    if (arabicMode) {
        try {
            const searchedArabic = await deepArabicYouTubeLyricsSearch(target);
            if (searchedArabic && validLanguage(searchedArabic)) {
                cacheSet(cacheKey, searchedArabic);
                return searchedArabic;
            }
        } catch (err) { lastError = err; }
    }

    // If databases do not have safe timings, search YouTube specifically for the exact
    // remix/edit/version and inspect caption tracks. This is deliberately deeper than v6.1.3.
    try {
        const searchedCaptions = await deepYouTubeCaptionSearch(target, preferredLanguage);
        if (searchedCaptions && validLanguage(searchedCaptions)) {
            const decision = keepOrReturnCjk(searchedCaptions);
            if (decision.returnNow) {
                cacheSet(cacheKey, searchedCaptions);
                return searchedCaptions;
            }
        }
    } catch (err) { lastError = err; }

    // For Japanese/Korean/Chinese, exhaust romanized/Latin-readable discovery first.
    // If none exists, fall back to the strongest safe native-script synced result rather
    // than returning no lyrics at all.
    if (nativeCjkFallback?.syncedLines?.length) {
        nativeCjkFallback.language = preferredLanguage;
        cacheSet(cacheKey, nativeCjkFallback);
        return nativeCjkFallback;
    }

    // Never animate with questionable timings. A strong same-song plain lyric result is
    // preferable to visibly wrong synced lyrics from the original mix.
    const bestPlain = pickBestLanguageResult(
        [...lrclibResults, ...karalyrResults, ...lrcMuxResults].filter(x => x?.plainLyrics),
        preferredLanguage,
    );
    if (bestPlain) {
        bestPlain.language = preferredLanguage;
        bestPlain.syncedLines = [];
        bestPlain.syncedLyrics = '';
        bestPlain.hasSynced = false;
        cacheSet(cacheKey, bestPlain);
        return bestPlain;
    }

    try {
        const plain = await deepPlainFallback(target, preferredLanguage);
        if (plain && validLanguage(plain)) {
            cacheSet(cacheKey, plain);
            return plain;
        }
    } catch (err) { lastError = err; }

    const empty = {
        source: '', title: target.primary?.title || rawTitle, artist: target.primary?.artist || rawAuthor,
        plainLyrics: '', syncedLines: [], hasSynced: false, language: preferredLanguage,
        error: lastError?.message || '',
    };
    cacheSet(cacheKey, empty);
    return empty;
}

function makePlainPages(lyrics, maxChars = 1750) {
    const clean = normalizeLyrics(lyrics);
    if (!clean) return [];
    const pages = [];
    let page = '';

    // نقسم النص الطويل بذكاء حتى لا يضيع آخر الكلمات إذا كانت فقرة واحدة ضخمة.
    const pushBlock = (block) => {
        block = String(block || '').trim();
        if (!block) return;

        if (block.length > maxChars) {
            const lines = block.split(/\n+/).map(x => x.trim()).filter(Boolean);
            if (lines.length > 1) {
                for (const line of lines) pushBlock(line);
                return;
            }
            for (let i = 0; i < block.length; i += maxChars) pushBlock(block.slice(i, i + maxChars));
            return;
        }

        const next = page ? `${page}\n\n${block}` : block;
        if (next.length > maxChars && page) {
            pages.push(page.trim());
            page = block;
        } else {
            page = next;
        }
    };

    for (const p of clean.split(/\n{2,}/)) pushBlock(p);
    if (page.trim()) pages.push(page.trim());
    return pages.length ? pages : [clean.slice(0, maxChars)];
}


function precedingSyncedIndex(lines = [], elapsed = 0) {
    if (!Array.isArray(lines) || !lines.length) return -1;
    const time = Math.max(0, Number(elapsed || 0));
    let low = 0, high = lines.length - 1, idx = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (Number(lines[mid]?.time || 0) <= time + 0.015) { idx = mid; low = mid + 1; }
        else high = mid - 1;
    }
    return idx;
}

function getCurrentSyncedIndex(lines = [], elapsed = 0) {
    const idx = precedingSyncedIndex(lines, elapsed);
    if (idx < 0) return -1;
    const end = lines[idx]?.endTime;
    // Captions may explicitly end before an instrumental break. LRC providers
    // without end times keep their usual "until next line" behavior.
    if (end != null && Number.isFinite(Number(end)) && Number(end) > Number(lines[idx].time) && Number(elapsed) >= Number(end)) return -1;
    return idx;
}

function makeSyncedPages(lines = [], activeIndex = -1, maxChars = 3000) {
    const pages = [];
    let page = [];
    let chars = 0;
    const safeLines = Array.isArray(lines) ? lines : [];
    for (let i = 0; i < safeLines.length; i++) {
        const text = normalizeSpaces(safeLines[i]?.text || '♪');
        const line = { ...safeLines[i], text, absoluteIndex: i, active: i === activeIndex };
        const lineLen = text.length + 24;
        if (page.length && (chars + lineLen > maxChars || page.length >= 22)) {
            pages.push(page);
            page = [];
            chars = 0;
        }
        page.push(line);
        chars += lineLen;
    }
    if (page.length) pages.push(page);
    return pages;
}

function getSyncedWindow(lines = [], elapsed = 0, before = 3, after = 4) {
    if (!Array.isArray(lines) || !lines.length) return { index: -1, lines: [] };
    const time = Math.max(0, Number(elapsed || 0));
    const idx = getCurrentSyncedIndex(lines, time);
    const center = idx < 0 ? Math.max(0, precedingSyncedIndex(lines, time)) : idx;
    const start = Math.max(0, center - before);
    const end = Math.min(lines.length, center + after + 1);
    return { index: idx, lines: lines.slice(start, end).map((line, offset) => ({ ...line, absoluteIndex: start + offset, active: idx >= 0 && start + offset === idx })) };
}

module.exports = {
    findLyrics,
    makePlainPages,
    getSyncedWindow,
    getCurrentSyncedIndex,
    makeSyncedPages,
    parseSyncedLyrics,
    splitArtistTitle,
    tryYouTubeCaptions,
    tryLrclibQuery,
    tryLrclibGet,
    tryYouTubeSearchCaptions,
    buildLyricsQueryVariants,
    normalizeArabicForSearch,
    hashKey,
    hasArabic,
    guessLyricsLanguage,
    // Internal scoring hooks used by regression tests; runtime callers should use findLyrics().
    _test: { fetchJson, fetchLyricsText, extractVersionProfile, versionRelation, durationRelation, buildTargetContext, candidateMetrics, lrclibToResult, splitArtistTitleDeep, parseSubtitlePayload, parseSrvCaptions, parseTtmlCaptions, uploaderLooksLikeCuratorDeep, subtitleCandidates, extractAnimeMusicIdentities, extractBilingualMusicIdentities, extractMetadataDescriptionIdentities, youtubeSearchQueries, arabicYoutubeSearchQueries, karalyrTaskUrls, deepKaralyrSearch, karalyrTargetKey, lrcMuxTaskUrls, deepLrcMuxSearch, lrcMuxToResult, lrcMuxTargetKey, scriptProfile, arabicLyricsQuality, englishLyricsQuality, identityStronglyEnglish, cjkReadableQuality, cjkRomanizationEvidence, captionLooksMachineTranslated, tryYouTubeCaptionsWithInfo, lyricsLanguageQuality, lyricsLanguageAcceptable, prefersRomanizedLyrics, resultIsRomanized, pickBestLanguageResult, inferPreferredLanguage, extractArabicLyricsFromDescription, alignPlainLyricsToTimingSkeleton, synthesizePlainTimings, calibrateSyncedToSkeleton, extractRomanizedDescriptionLyrics, deepCjkRomanizedDescriptionSearch, postProcessLyricsResult, identitySimilarity, _lyricsHttpStats: () => ({ active: lyricsHttpActive, waiting: lyricsHttpWaiters.length }), _lyricsYtDlpStats: () => ({ active: lyricsYtDlpActive, waiting: lyricsYtDlpWaiters.length, limit: LYRICS_YTDLP_CONCURRENCY }) },
};
