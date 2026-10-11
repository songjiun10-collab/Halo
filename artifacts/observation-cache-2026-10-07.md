# Observation visibility cache measurement

Date: 2026-10-07. Scope: backend BrowserAdapter observation, local Chromium.

The synchronous DOM scan memoizes repeated visibility checks per node. The
action binding retains the uncached visibility function, so later actions check
current DOM state. A regression test changes aria-hidden after observation.

## Paired measurement

One headless Chromium instance; about:blank populated with 20 or 3,000 paragraph
nodes. Actual BrowserAdapter.observe(), including CDP and host mapping. Two
warmup pairs, seven measured pairs, five observations per sample, alternating
baseline/optimized order. Baseline replaces the two traversal calls to
observedHidden with hidden in the generated script. No model calls.

| Nodes | Baseline median ms/observe | Optimized median | Reduction |
|---|---:|---:|---:|
| 20 | 7.3214918 | 8.0988 | -10.62% |
| 3000 | 145.8694666 | 90.8661 | 37.71% |

Raw samples (ms/observe):

```json
{
  "20": {
    "baseline": [4.59885,5.1392334,7.3214918,8.724075,13.0076918,7.3729082,6.1022166],
    "optimized": [4.04815,3.6243168,11.4307416,8.5213584,9.7679334,8.0988,4.3507668]
  },
  "3000": {
    "baseline": [146.0060334,133.804175,139.9011584,145.8694666,152.6884334,139.1426,151.3404082],
    "optimized": [91.4802,85.988325,98.7578918,90.8661,95.9980332,88.9564832,81.2466416]
  }
}
```

This supports a large-page observation improvement, not an end-to-end task
speed claim. Small-page results are noisy and show no benefit. Earlier separate
fixed-suite runs were slower after the patch (Chromium suite mean 7.68s to
12.16s), with other operations also slower; those runs do not isolate causation.

Browser adapter and interaction tests passed (71/71), including visibility
invalidation. Typecheck passed. The full application suite was interrupted
after repeated real Chromium startup/connection timeouts; it is not green.
