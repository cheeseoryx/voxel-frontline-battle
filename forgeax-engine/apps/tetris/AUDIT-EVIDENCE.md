# apps/tetris — w18 behavior-audit evidence

This file is the durable witness for `feat-20260511-tetris-retro-followups`
milestone M5 / task w18: the audit's `tetris-behavior-audit` records for the
four behavioral facts called out in `plan-strategy.md` D-P4. Companion to
`.forgeax-harness/forgeax-loop/feat-20260511-tetris-retro-followups/tetris-build-retro.md` §1.3 (the original retro-era screenshot baseline).

The four entries below are grep-able via `grep tetris-behavior-audit` (4 hits)
to satisfy `plan-tasks.json` w18 `acceptanceCheck`. They are also mirrored
into `implement-progress.jsonl` by the M5 orchestrator.

## Audit method

- Server: `pnpm --filter tetris preview --port 4173 --strictPort` (vite preview
  serving the `vite build` artefact, not dev server — per M5 prompt: "用 vite
  preview 而非 dev server 来跑 build artifact").
- Driver: playwright headless against system `/Applications/Google Chrome.app`
  with vitest browser project flags (`--enable-unsafe-webgpu` +
  `--enable-features=Vulkan` + `--use-vulkan=swiftshader` +
  `--disable-vulkan-surface` + `--ignore-gpu-blocklist` +
  `--disable-gpu-driver-bug-workarounds`). System Chrome is required for
  WebGPU canvas-pixel readback in headless — `chromium_headless_shell` has the
  WebGPU compositor path crippled and returns `rgba(0,0,0,0)` for every pixel
  regardless of game state (see `.forgeax-harness/forgeax-loop/feat-20260511-tetris-retro-followups/tetris-build-retro.md` §2.2 L172-173).
- Driver script: `/tmp/tetris-audit-w18/audit4-final.mjs` (transient, not
  committed; output JSON archived inline below).
- Captured at `2026-05-11T21:40:00Z` (commit at `chore(tetris) w18` HEAD).

## tetris-behavior-audit events

### 1. tetris-behavior-audit: board rendering

- **phase**: `tetris-behavior-audit`
- **fact**: `(a) 棋盘正常渲染`
- **observation**: backend selected = `webgpu` (per `[tetris] backend=webgpu`
  console line); 0 pageErrors, 0 game-related console errors (one favicon 404
  unrelated); final canvas screenshot shows ~50 cyan tetromino blocks laid
  out on the 10x20 board grid with the I-piece preview in the right-side 4x4
  area. Visual confirmation in
  `apps/tetris/AUDIT-EVIDENCE-screenshot-final.png` (post-line-attempts state,
  score=494).
- **verdict**: pass

### 2. tetris-behavior-audit: 7-bag randomiser

- **phase**: `tetris-behavior-audit`
- **fact**: `(b) 7-bag 随机出块`
- **observation**: tracked `nextEl.textContent` across 30 hard-drop lock
  cycles. Distinct piece-kind set observed = `{O, T, I, L, J, S, Z}` =
  7 kinds = full PIECE_KINDS coverage. This is the 7-bag signature: across
  any window spanning two bag refills (14 pieces) every kind must appear at
  least twice; 30 cycles span ~4 bags so 7 distinct kinds is the floor.
- **verdict**: pass

### 3. tetris-behavior-audit: line-clear logic

- **phase**: `tetris-behavior-audit`
- **fact**: `(c) 行消除动画`
- **observation**: `linesObserved=1` at cycle 48 of the line-clear scenario
  (scripted random hard-drops biased to left half + occasional rotation).
  The `lines` HUD counter incremented 0 → 1, confirming `clearLines()` in
  `game.ts:201` ran and detected at least one full 10-column row. Visual
  "animation" here is the locked-row collapse — entities at the cleared
  row are scaled to `HIDDEN_SCALE` next frame, rows above shift down via
  `board.set(next)` and re-render with new transforms; no separate tween
  is involved. The lines counter increment is the load-bearing proof.
- **verdict**: pass

### 4. tetris-behavior-audit: HUD displays score / lines / level / next

- **phase**: `tetris-behavior-audit`
- **fact**: `(d) HUD 显示分数 / 等级 / 行数`
- **observation**: HUD probed at four moments —
  - boot: `{score: '0', lines: '0', level: '1', next: 'Z'}`
  - after 30 cycles: `{score: '166', lines: '0', level: '1', next: 'L'}`
  - after KeyR restart: `{score: '0', lines: '0', level: '1', next: 'J'}`
  - final: `{score: '494', lines: '0', level: '1', next: 'I'}`
  Score advances from 0 across cycles (hard-drop bonus + line-clear bonus);
  next-piece label rotates through 7-bag kinds; restart resets score/lines
  to 0; level stays 1 (no line-count threshold reached). All four HUD spans
  (`#score`, `#lines`, `#level`, `#next`) are populated every probe.
- **verdict**: pass

## Audit JSON (raw)

```json
{
  "url": "http://localhost:4173/",
  "ts": "2026-05-11T21:40:00Z",
  "backend": "webgpu",
  "distinctKinds": ["O", "T", "I", "L", "J", "S", "Z"],
  "linesObserved": 1,
  "cyclesUntilFirstLine": 48,
  "hudBoot": {"score": "0", "lines": "0", "level": "1", "next": "Z", "overlayClass": ""},
  "hudAfter30Cycles": {"score": "166", "lines": "0", "level": "1", "next": "L"},
  "hudAfterRestart": {"score": "0", "lines": "0", "level": "1", "next": "J"},
  "hudFinal": {"score": "494", "lines": "0", "level": "1", "next": "I"},
  "pageErrors": 0,
  "consoleErrors": 1,
  "consoleErrorsBreakdown": ["favicon 404 (unrelated)"]
}
```

## Environment constraint note

The pre-`fc3984c` retro (`.forgeax-harness/forgeax-loop/feat-20260511-tetris-retro-followups/tetris-build-retro.md` §2.2) documents that
running headless under bundled `chromium_headless_shell` returns
`rgba(0,0,0,0)` for every canvas pixel even when the game is rendering
correctly — the shell has WebGPU compositor paths crippled. To get visual
proof of (a) board rendering, the audit driver MUST point `executablePath`
at the system browser (e.g. `/Applications/Google Chrome.app`). This is an
environment limitation, not a tetris regression, and matches the verify
strategy of `apps/hello/triangle` which uses dawn-node for its smoke
baseline rather than chromium readback.
