# Music Fleet v8.5.6

## Progressive home loading

- A cold-start home now keeps its existing shelf skeleton visible while the first personalized catalog stage is being prepared. It no longer flashes the empty onboarding panel before the first result batch arrives.
- The featured home stage has a shared nine-second catalog budget. When the available providers return enough data, it fills at least a third of the home shelves with fresh releases, recommendations, recent/favorite music, and varied chart or playlist content.
- The complete personalized home continues loading after that first stage and replaces or adds shelves in place while preserving the current scroll position.
- Home provider delays and temporary failures stay out of the visible error/toast flow. The page shows its normal empty state if no first-stage results are available while deeper discovery continues.
- No layout, player controls, artwork, lyrics, or stored user data were changed.

## Verification scope

- The focused home-responsiveness suite and complete platform test suite are run for this release.
- Local tests use simulated catalog providers; they do not prove live provider uptime or real-user network timings.
