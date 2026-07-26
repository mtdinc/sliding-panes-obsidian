import { App, Platform } from 'obsidian';
// Type-only: settings.ts imports this module for the pane-count commands, so a
// value import here would create a circular runtime dependency.
import type { SlidingPanesSettings } from './settings';
import {
  TabGroupLike,
  displayedLeaf,
  getLeafElements,
  getRootTabGroups,
  getTabContainer,
  groupForElement,
  isStacked,
  leafEl,
} from './adapter';
// The pane-count owner API re-parks panes after resizing them, and scroll-
// manager asks this module for the reveal lane: the two collaborate in both
// directions. Only function calls cross the boundary, never module-init work.
import { scrollLeafIntoView } from './scroll-manager';

// ---------------------------------------------------------------------------
// width-manager.ts is the SOLE owner of the inline width styles we write onto
// stacked leaves. Obsidian writes its own inline min/max-width on leaves that
// fights the `--tab-stacked-pane-width` CSS variable, so the only reliable way
// to control pane width is to set inline width/minWidth/maxWidth ourselves.
//
// It is equally the SOLE owner of HOW MANY panes are visible: the automatic
// rule (fit as many as the width setting allows) plus the two ways the user
// can override it — the pane-count dial and focus mode. The commands and the
// double-click gesture drive both through the small API at the bottom of this
// file; nothing outside this module reads or writes that state.
// ---------------------------------------------------------------------------

// The desktop/mobile pane width setting. In fixed mode this IS the pane width;
// in auto mode it is the floor a pane never shrinks below. Exported so
// style-manager uses the same rule — this function is the ONE owner of the
// platform choice.
export function getFixedWidth(settings: SlidingPanesSettings): number {
  if (Platform.isDesktop) {
    return settings.leafDesktopWidth;
  }
  return settings.leafMobileWidth;
}

// ---------------------------------------------------------------------------
// Manual pane count + focus mode (state)
// ---------------------------------------------------------------------------

// How many panes the user has asked to see, or null for "automatic" (the width
// setting decides). Persisted PER DEVICE, deliberately NOT as a setting:
// data.json syncs with the vault, and the whole point of the dial is that a
// 27" desktop keeps 3 panes while a laptop keeps 2.
let manualPaneCount: number | null = null;

// Focus mode: the active pane temporarily takes the whole group. Session-only
// and NEVER persisted — opening Obsidian should never start focused. It does
// not disturb the dial: the effective override below simply outranks it, so
// leaving focus restores the dial's value with nothing to remember.
let focusModeActive = false;

// Per-device storage key for the dial. Namespaced because the fallback path
// writes into the window's shared localStorage.
const PANE_COUNT_STORAGE_KEY = 'sliding-panes/visible-pane-count';

// Hard readability floor for MANUALLY chosen pane counts. Asking for eight
// panes on a laptop must not produce 90px slivers of text; when this floor
// bites, the panes simply overflow into stacking as they already do. It is
// deliberately independent of the width setting — that setting is the
// automatic rule's floor, and the dial exists to overrule the automatic rule.
const MANUAL_MIN_PANE_WIDTH = 280;

// The pane count actually in force, or null for automatic. Focus mode outranks
// the dial, and BOTH are inert while Leaf Auto Width is off — in fixed-width
// mode the width setting alone decides how many panes fit, and there is no
// space left to redistribute. That gate lives here, once, so every caller
// (widths, dial, focus, commands) sees the same answer.
function effectivePaneCountOverride(settings: SlidingPanesSettings): number | null {
  if (!settings.leafAutoWidth) {
    return null;
  }
  if (focusModeActive) {
    return 1;
  }
  return manualPaneCount;
}

// The auto-width geometry for one stacked group: how wide each pane is, how
// wide the edge-reveal strip's dedicated lane is (0 when it gets none), and how
// many panes that adds up to. They all come from the same arithmetic, so they
// live in one function — scroll-manager parks the active pane past the lane,
// and if it computed the lane independently the two could disagree and panes
// would land misaligned; the dial likewise counts panes from this result so
// "one more pane" means one more than what is actually on screen.
interface StackedAutoLayout {
  paneWidth: number;
  revealSlotWidth: number;
  visiblePanes: number;
  totalPanes: number;
}

// Panes that fit on screen tile it exactly: work out how many can be fully
// visible without shrinking below the fixed-width floor, then split the
// available space evenly among exactly that many. When every pane fits this
// is plain equal distribution (1 pane full width, 2 split in half, ...); once
// panes overflow into stacking, the visible panes still sit flush against the
// spines instead of leaving an arbitrary sliver or gap.
function computeStackedAutoLayout(group: TabGroupLike, tabContainer: HTMLElement, settings: SlidingPanesSettings): StackedAutoLayout {
  const tabHeaders = tabContainer.querySelectorAll('.workspace-tab-header');
  const numPanes = Math.max(tabHeaders.length, 1);
  const groupWidth = group.containerEl.clientWidth;
  const minimumWidth = getFixedWidth(settings);

  // Stacking pins ALL spines on screen at all times, so every spine
  // subtracts from the group width before panes divide what's left.
  let contentWidth = groupWidth - numPanes * settings.headerWidth;

  // Manual mode (dial or focus): the user has said how many panes they want to
  // see, so the width setting stops being the deciding vote and those panes
  // split everything that is left.
  const override = effectivePaneCountOverride(settings);
  if (override !== null) {
    const requestedPanes = Math.max(override, 1);
    const sharingPanes = Math.min(requestedPanes, numPanes);
    const dividedWidth = Math.floor(contentWidth / sharingPanes);
    const paneWidth = Math.max(dividedWidth, MANUAL_MIN_PANE_WIDTH);

    // How many of those panes are ACTUALLY on screen. Once the readability
    // floor bites, the extras overflow into stacking — asking for 8 panes in
    // 1010px of content still shows 3 — and visiblePanes has to say so: the
    // dial steps from this number, so reporting the request instead would make
    // several presses in a row change nothing while the Notice claimed
    // otherwise. (paneWidth is never below the floor, so this can't divide by
    // zero; a group too narrow to hold even one pane still reports one.)
    const panesThatFitOnScreen = Math.max(Math.floor(contentWidth / paneWidth), 1);

    return {
      paneWidth: paneWidth,
      // No lane for the reveal strip: manual panes claim ALL the space. The
      // strip still appears — it just overlaps the leftmost visible pane, the
      // same thing that already happens on a window with no spare room.
      revealSlotWidth: 0,
      visiblePanes: Math.min(sharingPanes, panesThatFitOnScreen),
      totalPanes: numPanes,
    };
  }

  const panesThatFit = Math.floor(contentWidth / minimumWidth);
  const visiblePanes = Math.min(Math.max(panesThatFit, 1), numPanes);

  // Once panes overflow into stacking, peek-manager shows the nearest buried
  // pane as an edge-reveal strip next to the spines. Give the strip its own
  // lane out of whatever space is SPARE after the visible panes take their
  // minimum — never more. Reserving a full lane unconditionally (the old
  // behavior) could cost an entire pane: a window fitting two 550px panes
  // with 70px spare would drop to ONE stretched pane just to give a 140px
  // strip its lane. Now the lane shrinks to the 70px that are actually free
  // and the strip overlaps the leftmost pane by the difference.
  // (No overflow → nothing buried → no strip → no lane.)
  let revealSlotWidth = 0;
  const panesOverflow = panesThatFit < numPanes;
  if (settings.edgeReveal && panesOverflow) {
    const spareWidth = contentWidth - visiblePanes * minimumWidth;
    revealSlotWidth = Math.max(0, Math.min(settings.edgeRevealWidth, spareWidth));
    contentWidth = contentWidth - revealSlotWidth;
  }

  const dividedWidth = Math.floor(contentWidth / visiblePanes);
  return {
    paneWidth: Math.max(dividedWidth, minimumWidth),
    revealSlotWidth: revealSlotWidth,
    visiblePanes: visiblePanes,
    totalPanes: numPanes,
  };
}

// The width of the edge-reveal strip's dedicated lane in this group, for
// scroll-manager to park the active pane past. 0 whenever no lane exists:
// feature off, stacking off, or no spare room in auto-width mode. In
// fixed-width mode panes never stretch to fill the group, so the lane is
// always the full configured width.
export function getRevealSlotWidth(group: TabGroupLike, settings: SlidingPanesSettings): number {
  if (!settings.edgeReveal || !settings.stackingEnabled) {
    return 0;
  }
  if (!settings.leafAutoWidth) {
    return settings.edgeRevealWidth;
  }
  const tabContainer = getTabContainer(group);
  if (!tabContainer) {
    return 0;
  }
  return computeStackedAutoLayout(group, tabContainer, settings).revealSlotWidth;
}

// The same geometry with stacking OFF (slide-off mode). No reveal strip exists
// there, so this one only answers "how wide" and "how many".
interface SlideOffAutoLayout {
  paneWidth: number;
  visiblePanes: number;
  totalPanes: number;
}

// Stacking OFF (slide-off) scrolls spines with their panes, so only the spines
// of the panes actually on screen take up room — and never more spines than
// panes that exist, or panes would come out too narrow and leave a gap on wide
// screens.
function computeSlideOffAutoLayout(group: TabGroupLike, tabContainer: HTMLElement, settings: SlidingPanesSettings): SlideOffAutoLayout {
  const tabHeaders = tabContainer.querySelectorAll('.workspace-tab-header');
  const numPanes = Math.max(tabHeaders.length, 1);
  const groupWidth = group.containerEl.clientWidth;
  const minimumWidth = getFixedWidth(settings);
  const spineWidth = settings.headerWidth;

  // Automatically: as many panes as fit at the width setting. Manually: as
  // many as the user asked for, down to the manual readability floor — the
  // same override rule the stacked branch above applies, so the dial behaves
  // identically in both modes.
  const panesThatFit = Math.floor(groupWidth / (minimumWidth + spineWidth));
  let requestedPanes = Math.max(panesThatFit, 1);
  let floorWidth = minimumWidth;

  const override = effectivePaneCountOverride(settings);
  if (override !== null) {
    requestedPanes = Math.max(override, 1);
    floorWidth = MANUAL_MIN_PANE_WIDTH;
  }

  const sharingPanes = Math.min(requestedPanes, numPanes);
  const contentWidth = groupWidth - sharingPanes * spineWidth;
  const dividedWidth = Math.floor(contentWidth / sharingPanes);
  const paneWidth = Math.max(dividedWidth, floorWidth);

  // Same rule as the stacked branch: in manual mode the readability floor can
  // leave fewer panes on screen than were asked for, and visiblePanes must
  // mean "actually on screen". Automatic mode sized itself to fit by
  // construction, so its count is left exactly as it was.
  let visiblePanes = sharingPanes;
  if (override !== null) {
    const panesThatFitOnScreen = Math.max(Math.floor(groupWidth / (paneWidth + spineWidth)), 1);
    visiblePanes = Math.min(sharingPanes, panesThatFitOnScreen);
  }

  return {
    paneWidth: paneWidth,
    visiblePanes: visiblePanes,
    totalPanes: numPanes,
  };
}

// In auto-width mode, panes tile the screen exactly; see the two layout
// functions above for the arithmetic. The spine accounting differs by mode,
// but in both the "visible pane" count is clamped: at least one pane is always
// visible, and we never spread wider than the number of panes that exist.
function computeAutoWidth(group: TabGroupLike, tabContainer: HTMLElement, settings: SlidingPanesSettings): number {
  if (settings.stackingEnabled) {
    return computeStackedAutoLayout(group, tabContainer, settings).paneWidth;
  }
  return computeSlideOffAutoLayout(group, tabContainer, settings).paneWidth;
}

// The target width (px) for panes in one stacked group.
function computeTargetWidth(group: TabGroupLike, tabContainer: HTMLElement, settings: SlidingPanesSettings): number {
  if (settings.leafAutoWidth) {
    return computeAutoWidth(group, tabContainer, settings);
  }
  return getFixedWidth(settings);
}

// Write our target inline width onto every leaf in one stacked group.
function applyWidthToGroup(group: TabGroupLike, settings: SlidingPanesSettings): void {
  const tabContainer = getTabContainer(group);
  if (!tabContainer) {
    return;
  }

  const targetWidth = computeTargetWidth(group, tabContainer, settings);
  const targetWidthPx = targetWidth + 'px';

  const leafElements = getLeafElements(tabContainer);
  leafElements.forEach((leafElement) => {
    // Skip leaves already at the target: this runs on every layout-change and
    // resize, and rewriting identical values still dirties style.
    const alreadyAtTarget =
      leafElement.style.width === targetWidthPx &&
      leafElement.style.minWidth === targetWidthPx &&
      leafElement.style.maxWidth === targetWidthPx;
    if (alreadyAtTarget) {
      return;
    }
    leafElement.style.width = targetWidthPx;
    leafElement.style.minWidth = targetWidthPx;
    leafElement.style.maxWidth = targetWidthPx;
  });
}

// Recalculate and apply pane widths across every managed, stacked root group.
// Called on enable, settings change, layout-change, and (debounced) resize.
export function recalcWidths(app: App, settings: SlidingPanesSettings): void {
  const groups = getRootTabGroups(app);
  groups.forEach((group) => {
    if (!isStacked(group)) {
      return; // we only manage stacked groups
    }
    applyWidthToGroup(group, settings);
  });
}

// Remove every inline width style we set, restoring Obsidian's own sizing.
// Clears ALL groups (not just stacked ones) so a group that was unstacked
// after we sized it is also restored.
export function clearWidths(app: App): void {
  const groups = getRootTabGroups(app);
  groups.forEach((group) => {
    const tabContainer = getTabContainer(group);
    if (!tabContainer) {
      return;
    }
    const leafElements = getLeafElements(tabContainer);
    leafElements.forEach((leafElement) => {
      leafElement.style.width = '';
      leafElement.style.minWidth = '';
      leafElement.style.maxWidth = '';
    });
  });
}

// ---------------------------------------------------------------------------
// Pane-count dial + focus mode (the owner API)
//
// Everything below is the ONLY way anything outside this file changes how many
// panes are visible. Each entry point decides what should happen, persists the
// dial when it moves, re-applies the widths itself, and hands back a ready-made
// Notice string — callers show the message and never have to remember a
// follow-up call.
// ---------------------------------------------------------------------------

// What a dial / focus command ended up doing.
export interface PaneCountOutcome {
  message: string;      // ready to show as a Notice
  changed: boolean;     // did the effective layout actually change?
  focusActive: boolean; // focus-mode state after the call
}

// The two reasons a pane-count change is refused. Callers show the message and
// stop; there is one owner of each rule AND of its explanation.
const AUTO_WIDTH_OFF_MESSAGE =
  'Sliding Panes: pane count follows the Leaf Width setting while Leaf Auto Width is off.';
const PLUGIN_OFF_MESSAGE = 'Sliding Panes is turned off.';

const NO_GROUP_MESSAGE = 'Sliding Panes: no stacked pane group to adjust.';

function describeOutcome(message: string, changed: boolean): PaneCountOutcome {
  return { message: message, changed: changed, focusActive: focusModeActive };
}

// What the dial landed on, and — when the readability floor stopped the screen
// from honouring it — what the user actually got.
function describePaneCount(requested: number, onScreen: number): string {
  let text = 'Sliding Panes: ' + requested + ' panes';
  if (requested === 1) {
    text = 'Sliding Panes: 1 pane';
  }
  if (onScreen < requested) {
    text = text + ' (only ' + onScreen + ' fit at readable width)';
  }
  return text;
}

// Obsidian 1.8.7+ exposes vault-scoped, per-device localStorage on App, and it
// IS in the typings — but our minAppVersion is 1.7.2, where the methods don't
// exist at runtime. Probe for them, and fall back to the window's own
// localStorage under a namespaced key.
function readStoredPaneCount(app: App): unknown {
  if (typeof app.loadLocalStorage === 'function') {
    return app.loadLocalStorage(PANE_COUNT_STORAGE_KEY);
  }
  return window.localStorage.getItem(PANE_COUNT_STORAGE_KEY);
}

function writeStoredPaneCount(app: App, count: number | null): void {
  if (typeof app.saveLocalStorage === 'function') {
    app.saveLocalStorage(PANE_COUNT_STORAGE_KEY, count); // null clears the entry
    return;
  }
  if (count === null) {
    window.localStorage.removeItem(PANE_COUNT_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(PANE_COUNT_STORAGE_KEY, String(count));
}

// Anything that isn't a whole number of at least one pane means "automatic".
// The stored value can be a number (Obsidian's API) or a string (the
// localStorage fallback), and either can be garbage from an older version.
function sanitizePaneCount(stored: unknown): number | null {
  let parsed = NaN;
  if (typeof stored === 'number') {
    parsed = stored;
  } else if (typeof stored === 'string') {
    parsed = parseInt(stored.trim(), 10);
  }

  if (!Number.isFinite(parsed)) {
    return null;
  }
  const wholePanes = Math.floor(parsed);
  if (wholePanes < 1) {
    return null;
  }
  return wholePanes;
}

// Load this device's saved pane count. Called once from main.ts on load.
export function initPaneCount(app: App): void {
  manualPaneCount = sanitizePaneCount(readStoredPaneCount(app));
  focusModeActive = false;
}

// Drop focus mode without touching the dial. Called when the plugin is
// disabled: focus is a session state and must not survive being switched off
// and on again.
export function clearFocusMode(): void {
  focusModeActive = false;
}

// Is the focused-pane layout actually in force? peek-manager asks before
// deciding whether to lift anything above the stack. Note the settings gate:
// focus mode is inert while Leaf Auto Width is off (the width setting decides
// the count there), so the lifts it suppresses must come back in that case.
export function isFocusLayoutActive(settings: SlidingPanesSettings): boolean {
  return effectivePaneCountOverride(settings) !== null && focusModeActive;
}

// How many panes one group is showing right now, and how many it has. The dial
// counts from this so "one more pane" means one more than what is actually on
// screen, whether that number came from the automatic rule or a previous press.
interface VisiblePaneCount {
  visible: number;
  total: number;
}

function countVisiblePanes(group: TabGroupLike, settings: SlidingPanesSettings): VisiblePaneCount | null {
  const tabContainer = getTabContainer(group);
  if (!tabContainer) {
    return null;
  }
  if (settings.stackingEnabled) {
    const layout = computeStackedAutoLayout(group, tabContainer, settings);
    return { visible: layout.visiblePanes, total: layout.totalPanes };
  }
  const layout = computeSlideOffAutoLayout(group, tabContainer, settings);
  return { visible: layout.visiblePanes, total: layout.totalPanes };
}

// The group the dial acts on: the one holding the active pane, falling back to
// the first stacked root group (right after startup focus can still be in a
// sidebar, and the dial should work anyway).
function targetGroup(app: App): TabGroupLike | null {
  const activeLeaf = app.workspace.getMostRecentLeaf();
  const activeElement = activeLeaf ? leafEl(activeLeaf) : null;
  if (activeElement) {
    const activeGroup = groupForElement(app, activeElement);
    if (activeGroup && isStacked(activeGroup)) {
      return activeGroup;
    }
  }

  const groups = getRootTabGroups(app);
  for (const group of groups) {
    if (isStacked(group)) {
      return group;
    }
  }
  return null;
}

// Re-apply the widths after a pane-count change, then put every stacked group's
// own active pane back between its pinned spines. Both halves belong here:
// recalcWidths resizes EVERY group at once, so in a split layout the group the
// user is not currently in would otherwise be left with its active pane sitting
// half under its own spines, with no event coming to move it. Parking several
// groups in one pass is safe because scroll-manager keys its stale-request
// guard per scroll container — sibling parks no longer cancel each other.
//
// Every mutator below funnels through here, so callers never have to remember a
// follow-up call.
function applyPaneCountChange(app: App, settings: SlidingPanesSettings): void {
  recalcWidths(app, settings);

  getRootTabGroups(app).forEach((group) => {
    if (!isStacked(group)) {
      return; // we only size (and therefore only re-park) stacked groups
    }
    // The pane this group is showing right now. adapter owns that decoding —
    // and see its comment for why the obvious workspace API is the wrong tool
    // here. A group whose shape it can't read is skipped rather than guessed at.
    const groupDisplayedLeaf = displayedLeaf(group);
    if (groupDisplayedLeaf) {
      scrollLeafIntoView(app, settings, groupDisplayedLeaf);
    }
  });
}

// Is the plugin in a state where the pane count means anything at all? While it
// is switched off there are no managed widths to change — writing them anyway
// would resurrect our inline widths on a workspace with none of our styling,
// and refresh() no-ops while disabled so nothing would take them off again.
function refusePaneCountChange(settings: SlidingPanesSettings): PaneCountOutcome | null {
  if (settings.disabled) {
    return describeOutcome(PLUGIN_OFF_MESSAGE, false);
  }
  if (!settings.leafAutoWidth) {
    return describeOutcome(AUTO_WIDTH_OFF_MESSAGE, false);
  }
  return null;
}

// The dial hit a clamp, so its stored value stays put — but leaving focus mode
// on the way in is itself a change, and reporting the clamp would then describe
// a screen that no longer exists.
function finishWithoutDialMove(app: App, settings: SlidingPanesSettings, leftFocusMode: boolean, clampMessage: string): PaneCountOutcome {
  if (!leftFocusMode) {
    return describeOutcome(clampMessage, false);
  }
  applyPaneCountChange(app, settings);
  return describeOutcome('Sliding Panes: focus mode off', true);
}

// Show one more (delta +1) or one fewer (delta -1) pane. Clamps at one pane and
// at the number of tabs in the group; a press that hits a clamp still reports
// why, so the hotkey never feels dead.
export function adjustPaneCount(app: App, settings: SlidingPanesSettings, delta: number): PaneCountOutcome {
  const refusal = refusePaneCountChange(settings);
  if (refusal) {
    return refusal;
  }

  const group = targetGroup(app);
  if (!group) {
    return describeOutcome(NO_GROUP_MESSAGE, false);
  }

  // Focus mode is a temporary one-pane override; reaching for the dial means
  // the user wants out of it.
  const leftFocusMode = focusModeActive;
  focusModeActive = false;

  const counts = countVisiblePanes(group, settings);
  if (!counts) {
    focusModeActive = leftFocusMode; // nothing to measure; leave the state alone
    return describeOutcome(NO_GROUP_MESSAGE, false);
  }

  // Count from what the user is looking at RIGHT NOW. While focused that is
  // exactly one pane — measuring the layout we just restored instead would make
  // a single "+1" press jump from one pane straight to three.
  let stepBase = counts.visible;
  if (leftFocusMode) {
    stepBase = 1;
  }

  const requestedCount = stepBase + delta;
  if (requestedCount < 1) {
    return finishWithoutDialMove(app, settings, leftFocusMode, 'Sliding Panes: already showing a single pane.');
  }
  if (requestedCount > counts.total) {
    const allPanesMessage = 'Sliding Panes: already showing all ' + counts.total + ' panes.';
    return finishWithoutDialMove(app, settings, leftFocusMode, allPanesMessage);
  }

  // Pressing on past the readability floor keeps landing on the same request
  // (the step base is what's on screen, not what was asked for), so a press
  // that doesn't move the dial must not claim a change and trigger a refresh.
  const dialMoved = requestedCount !== manualPaneCount;
  if (dialMoved) {
    manualPaneCount = requestedCount;
    writeStoredPaneCount(app, manualPaneCount);
  }

  const changed = dialMoved || leftFocusMode;
  if (changed) {
    applyPaneCountChange(app, settings);
  }

  // Measure again now that the change has landed: the readability floor may
  // have kept fewer panes on screen than were asked for. The request is still
  // what we store — a wider window later can honour it in full.
  const applied = countVisiblePanes(group, settings);
  let panesOnScreen = requestedCount;
  if (applied) {
    panesOnScreen = applied.visible;
  }
  return describeOutcome(describePaneCount(requestedCount, panesOnScreen), changed);
}

// Hand the pane count back to the automatic rule, and leave focus mode.
export function resetPaneCount(app: App, settings: SlidingPanesSettings): PaneCountOutcome {
  const refusal = refusePaneCountChange(settings);
  if (refusal) {
    return refusal;
  }

  const changed = manualPaneCount !== null || focusModeActive;
  focusModeActive = false;
  if (manualPaneCount !== null) {
    manualPaneCount = null;
    writeStoredPaneCount(app, null);
  }

  if (changed) {
    applyPaneCountChange(app, settings);
  }
  return describeOutcome('Sliding Panes: automatic pane count', changed);
}

// Turn focus mode on or off. On = the active pane gets the whole group; off =
// back to whatever the dial (or the automatic rule) said before, which needs no
// bookkeeping because focus never overwrites the dial, it only outranks it.
export function setFocusMode(app: App, settings: SlidingPanesSettings, on: boolean): PaneCountOutcome {
  if (settings.disabled) {
    return describeOutcome(PLUGIN_OFF_MESSAGE, false);
  }
  // Entering focus needs auto width — with it off the width setting decides the
  // count and focus would do nothing. LEAVING it must always be allowed: turn
  // auto width off while focused and this is the only way back out.
  if (on && !settings.leafAutoWidth) {
    return describeOutcome(AUTO_WIDTH_OFF_MESSAGE, false);
  }

  const message = on ? 'Sliding Panes: focus mode on' : 'Sliding Panes: focus mode off';
  if (focusModeActive === on) {
    return describeOutcome(message, false);
  }

  focusModeActive = on;
  // Only re-park when the flag can actually move the layout. Leaving focus
  // while auto width is off is the one case where it can't: the override was
  // already inert, so recalcWidths would rewrite identical widths and re-park
  // every group for nothing. The flag still flipped, so the outcome is a change
  // — peek-manager's reveal/pin suppression keys off it.
  if (settings.leafAutoWidth) {
    applyPaneCountChange(app, settings);
  }
  return describeOutcome(message, true);
}

export function toggleFocusMode(app: App, settings: SlidingPanesSettings): PaneCountOutcome {
  return setFocusMode(app, settings, !focusModeActive);
}
