# macOS Automated Acceptance Evidence — Issue #79

**Machine:** Apple Silicon macOS (Darwin 25.5.0)
**Node:** v26.0.0
**Date:** 2026-08-02
**ccps branch:** ticket/79-performance-acceptance

---

## Automated Test Suite

```
npm run check → lint ✓ | 1263 tests ✓ | build ✓
```

## Performance Thresholds — Baseline Tier (20×50)

| Metric | Threshold | Measured (p95) | Pass? |
|--------|-----------|----------------|-------|
| Cold start to interactive | ≤ 400 ms | 12.80 ms | ✓ |
| Keystroke to repaint | ≤ 50 ms | 0.06 ms | ✓ |
| Search filtering per keystroke | ≤ 100 ms | 0.02 ms | ✓ |
| Content search | ≤ 2000 ms (loading rule) | 5.31 ms | ✓ |

Full results: [`baseline-perf.json`](baseline-perf.json)

## Performance Thresholds — 3× Tier (60×150)

| Metric | Threshold | Measured (p95) | Pass? |
|--------|-----------|----------------|-------|
| Cold start | ≤ 400 ms | 36.40 ms | ✓ |
| Keystroke to repaint | ≤ 50 ms | 0.23 ms | ✓ |
| Search filtering | ≤ 100 ms | 0.04 ms | ✓ |
| Content search | ≤ 2000 ms (loading rule) | 5.83 ms | ✓ |

Full results: [`3x-perf.json`](3x-perf.json)

## Fixture Generation

- Baseline tier (20 profiles × 50 skills): materializes in ~288 ms
- 3× tier (60 profiles × 150 skills): materializes in ~2462 ms
- Deterministic golden plan: byte-identical across runs ✓

## Summary

All automated acceptance criteria pass on macOS. Data-layer performance is
well within §15.4 thresholds — cold start at ~13 ms (32× below the 400 ms
gate), keystroke repaint at ~0.06 ms (833× below the 50 ms gate), search
filtering at ~0.02 ms (5000× below the 100 ms gate).

The remaining acceptance dimensions (real terminal rendering, SIGCHLD path,
Windows junction semantics, CJK rendering, 0600 permission bits) require
real-machine manual testing per the [checklist](real-machine-checklist.md).
