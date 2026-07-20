# Sliding Panes v4.0 — Re-architecture on Native Stacked Tabs

**Status:** implemented 2026-07-20 (v4.0.0). Two-lens review passed (Codex adversarial + plan-compliance); all 6 review findings fixed (cross-realm element checks, phone guard + setStacked verification, seen-groups reset on enable, native layout nudge after style/width changes, popout-aware focus commands, one-owner width rule). Remaining roadmap: per-pane drag-resize (needs live-app iteration). Manual in-app verification pending (cannot run Obsidian in the build environment).
**Decision:** Option B — build on Obsidian's native Stacked Tabs (`.workspace-tabs.mod-stacked`) instead of re-implementing pane layout. Obsidian owns the core layout; this plugin adds only the gaps.

## Why

The v3 engine positions leaves manually, iterates `rootSplit.children` as panes (they are now `WorkspaceTabs` groups), and monkey-patches the private `onChildResizeStart`. All of that is deleted. Native Stacked Tabs replicates the core sliding-panes visual; what it lacks — and what v4 provides — is:

1. One-toggle stacking across ALL root tab groups (native command only affects the active group)
2. Pane width control (global setting + auto-width) — needs JS because Obsidian writes inline `min/max-width` on leaves that fight `--tab-stacked-pane-width`
3. Spine (rotated header) control: width, hide titles, flip direction, text orientation
4. Classic "slide-off" mode (stacking visual off): `position: static` override on `.workspace-tab-container > *`
5. Focus left/right pane commands (public API: root-leaf order + `setActiveLeaf`)
6. Reliable scroll-active-pane-into-view

Deferred to a later version: per-pane drag-resize (no prior art anywhere; needs live-app iteration).

## Architecture (one owner per rule)

```
┌─────────────────────────────────────────────────────────────────┐
│ main.ts (thin lifecycle)                                        │
│  onload → load settings → StyleManager.apply → Stacker.stackAll │
│  events: layout-change → Stacker.stackNew + WidthManager.recalc │
│          resize        → WidthManager.recalc (auto-width)       │
│          active-leaf-change → scrollActiveIntoView              │
├────────────────┬──────────────────┬─────────────────────────────┤
│ adapter.ts     │ style-manager.ts │ settings.ts                 │
│ SOLE owner of  │ SOLE owner of    │ settings class + tab UI     │
│ private/untyped│ body classes +   │ + commands (ids unchanged)  │
│ API access     │ injected <style> │                             │
└────────────────┴──────────────────┴─────────────────────────────┘
        styles.scss: static rules keyed off body classes
```

- `src/adapter.ts` replaces `obsidian-ext.ts` as the single fragility surface: enumerate root tab groups (main window + popouts via `floatingSplit`), `isStacked(group)` (reads `mod-stacked` class), `setStacked(group, on)` (runtime-probe internal method; if absent, log once and skip), `leafEl(leaf)`, `groupEl(group)`, `executeCommandById` (typed via module augmentation, used only as documented fallback).
- Public API preferred everywhere else: `iterateRootLeaves`, `setActiveLeaf(leaf, {focus:true})`, `on('layout-change'|'resize'|'active-leaf-change')`, `Platform`.

## Settings migration (keys preserved exactly, incl. misspelled `orienation`)

| v3 key | v4 meaning |
|---|---|
| `disabled` | master toggle: on-enable stack all root groups + apply styles; on-disable remove styles/classes and stop managing (do NOT force-unstack) |
| `leafDesktopWidth` / `leafMobileWidth` | `--tab-stacked-pane-width` + JS inline width/min/max on stacked leaves |
| `leafAutoWidth` | per group: width = groupEl.clientWidth − (numTabs − 1) × headerWidth |
| `headerWidth` | `--tab-stacked-header-width` |
| `rotateHeaders` | off → hide spine title+icon (spine stays, minimal) — semantic shift from v3, documented |
| `headerAlt` | `--tab-stacked-text-transform: rotate(180deg)` + `--tab-stacked-text-align: right` (kepano pattern) |
| `orienation` | mixed = default; upright = `text-orientation: upright`; sideway = `writing-mode: sideways-lr` on spine title |
| `stackingEnabled` | off → slide-off mode body class (`position: static` override) |
| `smoothAnimation` | `scroll-behavior: smooth` on tab containers + smooth scrollIntoView |

Commands: 6 existing ids unchanged; new `focus-left-pane` / `focus-right-pane`.

Auto-stack detail: only stack groups not previously seen (WeakSet) so a user's manual un-stack isn't fought.

## Files expected to change
`src/main.ts` (rewrite), `src/adapter.ts` (new), `src/style-manager.ts` (new), `src/settings.ts` (commands+UI adjustments), `src/styles.scss` (rewrite), delete `src/obsidian-ext.ts`, `manifest.json`/`versions.json`/`package.json` → 4.0.0, README status section.

Future change locality: a new spine style → styles.scss + one body class; a new private-API need → adapter.ts only.

## Verification
- `npm run build` clean (tsc + esbuild + sass)
- Codex adversarial review of full diff
- Manual test checklist for the user (cannot run Obsidian in this environment)
