# Sliding Panes (Andy Matuschak Mode) — Maintained Fork

> **About this fork (2026):** This is a fork of
> [deathau/sliding-panes-obsidian](https://github.com/deathau/sliding-panes-obsidian),
> which received its last update in **September 2022** (v3.4.0). Shortly after,
> Obsidian 1.0 replaced the pane system with tabs and shipped a native
> "Stacked tabs" mode, and the original plugin was no longer maintained and was
> eventually removed from the community plugin directory.
>
> We copied the project here in 2026 to keep maintaining it, because native
> Stacked Tabs still doesn't cover everything this plugin offered (per-pane
> resizing, hiding/sizing the rotated title spines, focus left/right
> navigation). All credit for the original plugin goes to
> [death_au](https://github.com/deathau).

Sliding Panes (Andy Matuschak Mode) as a plugin for [Obsidian](https://obsidian.md),
inspired by the UI of [Andy Matuschak's notes](https://notes.andymatuschak.org/).

![Screenshot](https://github.com/deathau/sliding-panes-obsidian/raw/master/screenshot.gif)

Instead of shrinking the workspace to fit panels, the panels remain a fixed
(but resizable) width and stack so you can scroll between them. Note headers
are rotated and added to the side of the pane like a spine (optional), and
stack up as you scroll (also optional), allowing easy navigation between them.

## Current status (2026)

- ✅ **v4.0 re-architecture:** the plugin now builds ON TOP of Obsidian's
  native **Stacked tabs** instead of fighting the tab-based workspace. Obsidian
  owns the core sliding layout; this plugin adds the parts it doesn't cover:
  one-toggle stacking across all tab groups, pane width control (fixed and
  auto-width), spine width / hiding / direction / text orientation, a classic
  "slide-off" mode, focus left/right commands, and scroll-active-into-view.
- ✅ **Toolchain modernized:** builds with esbuild + TypeScript 5 against the
  current Obsidian API (the original used Rollup 2 / TS 4.7 / API 0.15).
- ⚠️ **Not yet re-added:** per-pane drag-resize (planned; needs live-app
  iteration). Desktop/tablet only — Obsidian removed stacked tabs on phones.
- ℹ️ Semantics shifted slightly from v3: "rotated headers off" now hides the
  spine text (the spine itself is native), and "stacking off" gives the classic
  slide-off look where panes slide under each other without sticky spines.

## Features

- Panes stay a fixed, resizable width and stack as you scroll
- Note headers stack up on the right _as well as_ the left
- Changing the active pane scrolls it into view
- Hover a collapsed pane's spine to peek at its content without activating it
- In auto-width mode, visible panes tile the screen exactly — no slivers or
  dead gaps once stacking begins
- Togglable without copying CSS into your theme
- Togglable sub-features: rotated headers, header direction, stacking, hover peek

## Settings

- **Toggle Sliding Panes** — turns sliding panes on or off globally *(also available via command/hotkey)*
- **Leaf Auto Width** — pane width fills the available space *(also via command/hotkey)*
- **Leaf Width** — the default width of a single pane
- **Toggle rotated headers** — rotates headers to use as spines *(also via command/hotkey)*
- **Swap rotated header direction** — swaps the direction of rotated headers *(also via command/hotkey)*
- **Toggle stacking** — panes stack up to the left and right *(also via command/hotkey)*
- **Hover Peek** — hovering a collapsed pane's spine briefly lifts that pane above the stack for a quick look *(also via command/hotkey)*
- **Spine Width** — the width of the rotated header (or gap) for stacking

## Compatibility

This fork targets the current Obsidian API (`minAppVersion` in
`manifest.json` is the authoritative value). It is **not** listed in the
community plugin directory.

## Installation

This plugin is not in the community directory, so installation is manual:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   release on this repository (or build them yourself, see Development).
2. Create the folder `<vault>/.obsidian/plugins/sliding-panes-obsidian/` and
   copy the three files into it.
   (On macOS press `Cmd+Shift+.` in Finder to show the hidden `.obsidian` folder.)
3. In Obsidian, open **Settings → Community plugins**, turn off Restricted
   mode if needed, and enable **Sliding Panes (Andy's Mode)**.

Alternatively, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) and
point it at `mtdinc/sliding-panes-obsidian`.

## Development

```bash
npm install        # install dependencies
npm run dev        # TypeScript watch mode (styles compile once at startup)
npm run build      # type-check + production build (main.js + styles.css)
```

Note: `npm run dev` recompiles TypeScript on every change, but styles are only
compiled when it starts — after editing `src/styles.scss`, restart `npm run dev`
or run `npm run build` to regenerate `styles.css`.

Copy `manifest.json`, `main.js`, and `styles.css` into
`<vault>/.obsidian/plugins/sliding-panes-obsidian/` and reload Obsidian to
test changes. Styles are authored in `src/styles.scss` and compiled to
`styles.css` by the build.

## Credits & License

Original plugin by [death_au](https://github.com/deathau) — if you find this
useful, consider supporting the original author:
[GitHub Sponsors](https://github.com/sponsors/deathau) ·
[PayPal](https://paypal.me/deathau).

MIT licensed — see [LICENSE](LICENSE). This fork preserves the original MIT
license and attribution.

# Version History

## 4.0.0 (fork, 2026)
- Re-architected on top of Obsidian's native Stacked Tabs: deleted the v3
  manual layout engine (pane positioning math, private resize monkey-patch,
  header DOM rewriting) — Obsidian now owns the core sliding layout
- All v3 settings and commands preserved (same keys, same command ids);
  existing `data.json` settings load unchanged
- New: Focus Left Pane / Focus Right Pane commands (work in popout windows)
- New: auto-stacks all root tab groups when enabled; respects groups you
  manually un-stack while the plugin is on
- Spine styling now uses Obsidian's official `--tab-stacked-*` CSS variables

## 3.5.0 (fork, 2026)
- Forked from deathau/sliding-panes-obsidian at v3.4.0
- Migrated build toolchain from Rollup 2 to esbuild; TypeScript 4.7 → 5.x;
  built against the current Obsidian API typings
- Added crash guards for deferred views (Obsidian 1.7.2+) and header
  aria-label changes
- Removed dead CodeMirror 5 styling and a no-op event unsubscription
- Added the missing MIT LICENSE file

## 3.4.0
- Updates to make the plugin load on Obsidian 0.16 (original author's final
  release; known broken visuals under the new tab UI)

## 3.3.0
- Sliding panes should now work as expected in popout windows!
- Pane resizing is back (but not saved to the workspace)
- Some previous dodginess when toggling the plugin on and off and attempting to resize panes has been resolved
- (Some) optimisations to streamline and speed things up a little bit.

## 3.2.5
- Quick fix to prevent sliding panes in popout windows, as the experience is currently borked.

## 3.2.4
- Fixed some focus issues with Obsidian 0.15
- Added seperate options for desktop and mobile leaf width (thanks @Bevaz)

## 3.2.3
- Add an option to select text-orientation (thanks @yo-goto)
- Allow user to disable smooth animations (thanks @cfree3)

## 3.2.2
- Fixed closing notes activating the leftmost note
- Fixed position of search suggestions
- Properly remove custom styling when moving a pane into a sidebar
- Added the note title to the icon, so if your panes are stacked, but you're not rotating headers, you can hover over the icon to see the note title.

## 3.2.1
- Changed the name slightly to drop the "Matuschak". Sorry Andy, but your name's just a tad unwieldy...
- Styling tweaks to better center the elements of rotated headers
- Fixed the ugly shadow smudge introduced in the previous release
- Fixed a code typo which was causing issues with opening and closing background panes

## 3.2.0
- Added an "auto width" mode, where each pane will take up the available space between the spines on the left and right
- Fix suggestion container positioning for tags (and related console errors) - Thanks, yet again, Eric Hall
- Fixed orientation of emojis in rotated headers (thanks GreenChocho and NothingIsLost)
- Fixed an error when loading workspaces
- Fixed compatibility issues with MrJackphi's Backlinks into the document plugin

## 3.1.1
- Quick fix for rightmost header hiding and extra scrollbar

## 3.1.0
- Update the link suggestion container position (thanks again, @erichalldev)
- Add the option (and command palette command) to turn stacking off (i.e. slide-off mode, like the v1 of Andy's Mode CSS)
- Add the option (and command palette command) to make the rotated header titles face the other direction
- Add a command palette command to toggle rotated headers
- Allow pane resizing (except the last pane, because it doesn't have a handle currently)
- Fix an issue with switching to off-screen panes not animating correctly (can still jump without animation if you switch too far too quickly)

## 3.0.2
- Add a setting to disable rotated headers
- Update focusLeaf to scroll just far enough to make a leaf fully visible if it's out of view to the right (thanks @erichalldev)
- Activate adjacent leaf when active leaf is closed (thanks again, @erichalldev)
- Close leaves which happen to have a file open that is deleted

## v3.0.1
- Quick fix to prevent the plugin from affecting sidebars

## v3.0.0
### New Features (vs the CSS-only version)
- Note headers stack up on the right as well as the left.
- Changing active pane scrolls that pane into view.
- Togglable without having to copy CSS into your theme.
