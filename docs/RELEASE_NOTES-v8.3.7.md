# Music Fleet v8.3.7

## Audio and workload capacity

- Raised the default audio stream high-water mark from 32 MiB to 64 MiB. `STREAM_HIGH_WATER_MARK` can be increased to 128 MiB in `config.js`; this is a buffering threshold, not memory preallocated for every stream.
- Removed the default fixed 7 GiB V8 heap cap. `PERFORMANCE_NODE_HEAP_MB: 0` lets Node choose its heap from the host runtime; set a positive MB value to add an explicit heap cap. `NODE_HEAP_MB` remains an environment override.
- Increased audio encoder thread budget to six per active stream when CPU capacity permits; simultaneous rooms share detected logical CPU capacity fairly. The process is not pinned to a CPU set.
- Doubled configured artwork, now-playing card, image, lyrics-session, bot client-cache, and prefetch budgets where the runtime supports these settings. Increased background audio-cache concurrency to six and heavy-job concurrency to two.
- Increased the libuv worker-pool ceiling from 32 to 1024; the default remains all detected logical CPUs.

## Preserved user state

- Release construction starts from the supplied v8.3.6 archive. It preserves the archive's bot/application IDs, server restrictions, all other existing configuration values, tokens, and `data/` files; only the listed performance settings are merged from the tested source.

## Validation limits

- The Node syntax checks, fleet configuration check, and focused room/activity regression suite are local package checks. No live Discord connection or long-duration uptime run is claimed.
- Buffer and cache settings increase possible memory use. Hardware, Node's runtime, Discord rate limits, and external media/lyrics services still determine real throughput; no software can promise unlimited resources or unlimited bot concurrency.
