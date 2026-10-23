# Music Fleet v8.5.3

## Catalog completion and responsive loading

- Extended catalog work budgets and queue waits so selected releases, Explore categories, and album tracklists are not discarded after a short local queue deadline.
- Expanded the home new-release detail sample from six to twelve unique releases, improving the number and artist variety of playable new-track recommendations.
- Increased shared catalog concurrency and queue capacity while retaining provider-specific rate gates and bounded queues.
- Fixed provider requests to honor route-specific timeout budgets, including search and playable-source fallback; catalog pages now allow up to three minutes before showing a network timeout state.
- Kept navigation cancellation, per-provider rate limits, recommendation ranking, and the existing interface structure intact.
- Added regressions for delayed catalog responses, queue completion beyond five seconds, and diverse home release coverage.

## Verification scope

These changes improve bounded local retrieval and queue behavior. They do not guarantee a third-party catalog will return a complete discography or fresh data, and no implementation can make physical RAM, storage, network capacity, or provider rate limits unlimited. The project retains user data and tokens in the package; verify the final archive privately before redistribution.
