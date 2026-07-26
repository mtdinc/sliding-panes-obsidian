import { App, Notice, setIcon } from 'obsidian';
// Type-only: settings.ts imports this module for the pin command, so a value
// import here would create a circular runtime dependency.
import type { SlidingPanesSettings } from './settings';
import {
  collectDocuments,
  followingStackedSiblings,
  getRootTabGroups,
  getTabContainer,
  isManagedElement,
  isStacked,
  leafEl,
  leafForElement,
  leafForHeader,
  TabGroupLike,
} from './adapter';

// ---------------------------------------------------------------------------
// peek-manager.ts is the SOLE owner of interactions that lift a pane above
// the stack. There are three of them, from most transient to most persistent:
//
//  PEEK (hover): hover a spine — or a revealed content strip — for
//  PEEK_SHOW_DELAY_MS and the full pane lifts; it drops PEEK_HIDE_DELAY_MS
//  after the pointer leaves the spine/strip and the lifted pane.
//
//  REVEAL (automatic): the nearest buried pane on the LEFT is always shown as
//  a content strip sitting just after the pinned spines, clipped to
//  edgeRevealWidth. width-manager gives the strip a lane out of whatever
//  space is spare after the visible panes take their minimum width — the
//  lane can shrink to zero on tight windows, in which case the strip simply
//  overlaps the leftmost visible pane (it lifts above the stack anyway).
//  Re-evaluated on every deck scroll / resize / layout change.
//
//  PIN (manual): every spine carries a small pin button (bottom of the spine,
//  fades in on hover). Pinning keeps that pane's left half visible whenever
//  it is buried; it disengages automatically while the pane is fully in view.
//  Pin state lives only on the leaf element (a CSS class) — session-level by
//  design, not persisted.
//
// All three work the same way underneath: native stacked tabs paint by DOM
// order with no inline z-index, so raising the pane's z-index lifts it in
// place, still pinned by its own sticky offset — no scrolling, no layout
// shift. Stacking order: peek (10) over pin (9) over reveal (8), and the CSS
// rules are declared in reverse order so peek also un-clips a pinned or
// revealed pane while hovered.
// ---------------------------------------------------------------------------

// Classes styles.scss keys off.
const PEEK_CLASS = 'sliding-panes-peek';
const PEEK_CLOSING_CLASS = 'sliding-panes-peek-closing'; // held briefly so the shrink animates
const REVEAL_CLASS = 'sliding-panes-reveal';
const PIN_STATE_CLASS = 'sliding-panes-pinned';        // leaf: user pinned it
const PIN_ENGAGED_CLASS = 'sliding-panes-pin-engaged'; // leaf: pinned AND buried → lifted half-out
const PIN_BUTTON_CLASS = 'sliding-panes-pin-button';   // the spine button
const PIN_BUTTON_ON_CLASS = 'is-pinned';               // button state modifier

// Purely a rendering hint: promotes a still-buried pane to its own compositing
// layer so the browser rasterizes ALL of it before we lift it. Changes nothing
// visible on its own (no z-index, no clip).
const PRELIFT_CLASS = 'sliding-panes-prelift';

// Inline CSS variables carrying the reveal strip's clip geometry.
const REVEAL_CLIP_LEFT_VAR = '--sp-reveal-left';
const REVEAL_CLIP_RIGHT_VAR = '--sp-reveal-right';

// Inline CSS variable carrying an engaged pin's clip, in px. style-manager
// publishes a percentage fallback of the same name on the group; the inline
// value written per evaluation pass is geometry-true and wins over it.
const PIN_CLIP_RIGHT_VAR = '--sp-pin-clip-right';

// Inline CSS variables carrying the clip a closing pane shrinks TOWARD — set
// by beginClosing so the shrink lands exactly on the pane's natural resting
// state (reveal strip, pinned half, or fully covered), making the final class
// removal invisible.
const CLOSING_CLIP_LEFT_VAR = '--sp-closing-left';
const CLOSING_CLIP_RIGHT_VAR = '--sp-closing-right';

// Hover this long before lifting, so sweeping the mouse across the spines
// doesn't flash panes up and down.
const PEEK_SHOW_DELAY_MS = 300;

// Grace period after the pointer leaves, so crossing a few pixels of gap
// between the spine and the lifted pane doesn't drop the peek.
const PEEK_HIDE_DELAY_MS = 250;

// Duration of the peek grow/shrink CSS transition. This constant is the ONE
// owner of that number: style-manager publishes it as --sp-lift-anim-ms and
// styles.scss consumes the variable, so tuning it here changes both sides.
export const PEEK_TRANSITION_MS = 200;

// How long the closing class stays on a pane after its peek drops. Slightly
// longer than the transition so the shrink finishes animating.
const PEEK_CLOSING_MS = PEEK_TRANSITION_MS + 50;

// How much of a pinned pane stays visible while it is buried. This constant
// is the ONE owner of that geometry: style-manager publishes the matching
// clip as --sp-pin-clip-right for styles.scss, and closingDestination() below
// uses it so a closing peek lands exactly on the pinned clip.
export const PIN_VISIBLE_FRACTION = 0.5;

// Painted rects closer than this are treated as touching, not overlapping
// (integer width rounding can leave a stray pixel).
const OVERLAP_EPSILON_PX = 2;

// Hard ceiling on how much of a pane the reveal strip may show, as a fraction
// of the pane's width. The Edge Reveal Width setting can legitimately be set
// wider than a pane is (a 600px strip on a 550px pane), and an unclipped
// "strip" is just a pane with a drop shadow painting over its neighbours.
const MAX_REVEAL_FRACTION = 0.6;

// Live references, set by attach(). Handlers read them at event time so
// settings toggles take effect without re-registering anything.
let currentApp: App | null = null;
let currentSettings: SlidingPanesSettings | null = null;

// Documents we've added our delegated listeners to (main window + popouts).
let attachedDocuments: Document[] = [];

let showTimer: number | null = null;
let hideTimer: number | null = null;

// The leaf currently animating its shrink back to strip/buried state.
let closingLeaf: HTMLElement | null = null;
let closingTimer: number | null = null;

// The leaf whose show-timer is pending, and the currently lifted (peeked) leaf.
let pendingLeaf: HTMLElement | null = null;
let peekedLeaf: HTMLElement | null = null;

// The leaf currently carrying the prelift (pre-rasterization) class, and the
// timer that drops it once the lift it prepared has finished animating. At
// most one at a time — only one pane is ever about to be lifted.
let preliftLeaf: HTMLElement | null = null;
let preliftTimer: number | null = null;

// A pane the user just ACTIVATED while it was still buried. It stays lifted
// (same class as a peek) until the scroll-into-view uncovers it; without this
// the pane is invisible — painted under its right-hand neighbors — for the
// whole scroll animation. Unlike a peek, a landing ignores hover entirely.
let landingLeaf: HTMLElement | null = null;
let landingTimer: number | null = null;

// Fail-safe ceiling for a landing. The normal release is geometric (the pane
// is no longer covered), but if the scroll never uncovers it — interrupted
// scroll, a layout we didn't predict — the lift must not stay up forever: a
// stuck lifted pane covers everything painted below it.
const LANDING_MAX_MS = 1500;

// Every leaf currently pinned, so evaluation can visit them directly.
// Disconnected leaves are pruned on evaluation.
const pinnedLeaves = new Set<HTMLElement>();

// Every leaf currently carrying a reveal strip, so we can clear stale ones.
const revealedLeaves = new Set<HTMLElement>();

// Documents that already have an evaluation queued for THEIR next animation
// frame. Per-document rather than one global flag: a popout window's rAF runs
// on its own clock, and an occluded main window's rAF is throttled to a crawl
// (or stops entirely) — sharing one latch would freeze the popout's clips.
const documentsWithQueuedEvaluation = new Set<Document>();

// One ResizeObserver per attached stacked tab container. Catches size changes
// that fire NEITHER Obsidian's resize event NOR layout-change: theme switches,
// CSS snippet edits, font-size changes, sidebar drag-resizes.
const containerResizeObservers = new Map<HTMLElement, ResizeObserver>();

function cancelShow(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  pendingLeaf = null;
  // NB: deliberately does NOT touch the prelift. A peek that is currently
  // growing still needs its layer, and cancelShow runs on paths that only mean
  // "no new peek is pending" (the pointer settling back on the lifted pane).
  // The paths that really end a lift — clearNow and windDownPeek — clear it.
}

function cancelHide(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}

// End any in-progress shrink animation immediately.
function finishClosingNow(): void {
  if (closingTimer !== null) {
    window.clearTimeout(closingTimer);
    closingTimer = null;
  }
  if (closingLeaf) {
    closingLeaf.classList.remove(PEEK_CLOSING_CLASS);
    closingLeaf.style.removeProperty(CLOSING_CLIP_LEFT_VAR);
    closingLeaf.style.removeProperty(CLOSING_CLIP_RIGHT_VAR);
    closingLeaf = null;
  }
}

// Is the plugin on AND in stacking mode? Every lift feature (peek, reveal,
// pin) requires this; the per-feature gates below build on it.
function isStackingActive(settings: SlidingPanesSettings): boolean {
  return !settings.disabled && settings.stackingEnabled;
}

// ---------------------------------------------------------------------------
// Geometry: how much of a pane is actually visible?
//
// Every clip this file writes — reveal strip, pin, closing animation — answers
// the same question: "where does the pane in front of this one start?". That
// question has exactly ONE owner here (uncoveredSpan), so the three clips can
// never disagree and leave a dead strip of background between two panes.
// ---------------------------------------------------------------------------

// The only parts of a DOMRect we ever use. Kept as a plain object so a whole
// group can be measured up front and then reasoned about without touching the
// DOM again (see evaluateNow's measure-then-mutate split).
interface PaneRect {
  left: number;
  right: number;
  width: number;
}

function measurePane(element: HTMLElement): PaneRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right, width: rect.width };
}

// Rects of everything stacked after this pane — following panes AND following
// spines. The container interleaves them (header, leaf, header, leaf, ...), so
// the element sitting immediately to a pane's right is the NEXT PANE'S SPINE.
// Stacked children paint in DOM order with no inline z-index, so exactly these
// elements, and no others, can paint over the pane.
function followingSiblingRects(leaf: HTMLElement): PaneRect[] {
  return followingStackedSiblings(leaf).map(measurePane);
}

// THE coverage rule. How many pixels from a pane's left edge are still visible,
// given everything stacked after it? We take the LEFTMOST following element,
// not just the adjacent one, for two reasons:
//
//  - with narrow panes the neighbour-after-next can pin further left than the
//    immediate neighbour, so looking one step ahead reported a pane as
//    uncovered while it was in fact buried two deep;
//  - spines count. Measuring only to the next PANE'S left edge overshoots by
//    one spine width, and every clip derived from this — most visibly the
//    reveal strip — then extends underneath that spine, swallowing its title
//    and its pin button (clip-path clips hit-testing too).
//
// Returns the pane's full width when nothing after it overlaps at all: a fully
// visible pane's next sibling is its neighbour's spine, sitting exactly at its
// right edge.
function uncoveredSpan(leafRect: PaneRect, followingRects: PaneRect[]): number {
  let nearestCoverLeft = leafRect.right;
  followingRects.forEach((rect) => {
    if (rect.left < nearestCoverLeft) {
      nearestCoverLeft = rect.left;
    }
  });

  const span = nearestCoverLeft - leafRect.left;
  return Math.max(0, Math.min(span, leafRect.width));
}

// Everything the clip rules need to know about ONE pane, measured in one go:
// its own box, and how much of it is still visible. Callers holding a single
// element use this; evaluateNow's group pass measures the whole container up
// front instead and feeds uncoveredSpan directly.
function measureVisibility(leaf: HTMLElement): { rect: PaneRect; visibleSpan: number } {
  const rect = measurePane(leaf);
  return { rect, visibleSpan: uncoveredSpan(rect, followingSiblingRects(leaf)) };
}

// THE owner of "how much of a pinned pane stays visible while it is buried".
// The floor is PIN_VISIBLE_FRACTION of the pane, but when MORE of it happens
// to be uncovered right now we clip to the real geometry instead — clipping
// tighter than the true edge would carve a dead strip of background between
// the pinned pane and the neighbour covering it.
function pinClipRightPx(leafRect: PaneRect, visibleSpan: number): number {
  const visible = Math.max(leafRect.width * PIN_VISIBLE_FRACTION, visibleSpan);
  return Math.max(0, leafRect.width - visible);
}

// Write a px CSS variable, but only when the whole-pixel value actually
// changed. These run on every scroll frame and rewriting an identical value
// still dirties style and forces a recalc — same guard width-manager uses for
// its inline widths. Returns true when the value moved, so callers that need
// to react to a real change (restarting a transition, say) can tell.
function setPxVar(element: HTMLElement, name: string, value: number): boolean {
  const rounded = Math.round(value) + 'px';
  if (element.style.getPropertyValue(name) === rounded) {
    return false;
  }
  element.style.setProperty(name, rounded);
  return true;
}

// Where does this pane's clip end up once the lift is fully gone? The closing
// animation holds the pane at peek z-index and shrinks its clip to exactly
// this destination, so dropping the closing class afterwards changes nothing
// on screen — no snap, no shadow pop.
function closingDestination(leaf: HTMLElement): { left: number; right: number } {
  if (leaf.classList.contains(REVEAL_CLASS)) {
    // Falling back to the reveal strip: reuse its exact clip — but only if
    // BOTH variables really parse. An absent or malformed var yields NaN, and
    // treating that as 0 clips nothing: the pane would flash out at FULL width
    // over its neighbours for the length of the animation. Measured geometry
    // below is always a safe answer, so fall through instead.
    const left = parseFloat(leaf.style.getPropertyValue(REVEAL_CLIP_LEFT_VAR));
    const right = parseFloat(leaf.style.getPropertyValue(REVEAL_CLIP_RIGHT_VAR));
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return { left, right };
    }
  }

  const { rect, visibleSpan } = measureVisibility(leaf);

  if (leaf.classList.contains(PIN_ENGAGED_CLASS)) {
    // Falling back to the pinned visible portion — through the same owner the
    // pin itself uses, so the handoff at class-drop is pixel-identical.
    return { left: 0, right: pinClipRightPx(rect, visibleSpan) };
  }

  // Plain buried pane: what survives the clip is exactly the sliver that stays
  // visible naturally, so the handoff is seamless.
  return { left: 0, right: Math.max(0, rect.width - visibleSpan) };
}

// (Re)start the countdown that drops the closing class. Called when a shrink
// begins, and again whenever the shrink's destination MOVES: re-aiming restarts
// the CSS transition from wherever the clip is right now, so the class must
// outlive the new animation too. Dropping it on the original schedule while
// the deck is still scrolling would cut the transition off part-way and snap.
function restartClosingTimer(): void {
  if (closingTimer !== null) {
    window.clearTimeout(closingTimer);
  }
  closingTimer = window.setTimeout(() => {
    closingTimer = null;
    finishClosingNow();
  }, PEEK_CLOSING_MS);
}

// Hold the closing class on a pane briefly so the CSS transition can animate
// its clip back down to its resting state instead of snapping.
function beginClosing(leaf: HTMLElement): void {
  finishClosingNow();
  if (leaf.isConnected) {
    const destination = closingDestination(leaf);
    setPxVar(leaf, CLOSING_CLIP_LEFT_VAR, destination.left);
    setPxVar(leaf, CLOSING_CLIP_RIGHT_VAR, destination.right);
  }
  closingLeaf = leaf;
  leaf.classList.add(PEEK_CLOSING_CLASS);
  restartClosingTimer();
}

// Promote a pane to its own compositing layer WITHOUT changing anything
// visible, so the browser rasterizes its full content while it is still
// buried. Applied at hover-intent and one frame before a landing lift: the
// lift then uncovers already-painted pixels instead of never-painted area,
// which is what used to show up as black tiles filling in piece by piece.
function setPrelift(leaf: HTMLElement): void {
  if (preliftLeaf === leaf) {
    return;
  }
  clearPrelift();
  leaf.classList.add(PRELIFT_CLASS);
  preliftLeaf = leaf;
}

// Keep the prelift layer until the grow animation has finished. Dropping the
// hint the instant the peek class lands would throw the pre-rasterized layer
// away at exactly the moment the clip starts opening — the browser would
// re-raster mid-animation, which is the flash the prelift exists to prevent.
function schedulePreliftRelease(leaf: HTMLElement): void {
  if (preliftTimer !== null) {
    window.clearTimeout(preliftTimer);
  }
  preliftTimer = window.setTimeout(() => {
    preliftTimer = null;
    clearPrelift(leaf);
  }, PEEK_TRANSITION_MS);
}

// Drop the prelift hint. With `only` given, drop it only if that exact pane is
// the one holding it — so releasing a landing can't cancel a hover's prelift.
function clearPrelift(only?: HTMLElement | null): void {
  if (only && preliftLeaf !== only) {
    return;
  }
  if (preliftTimer !== null) {
    window.clearTimeout(preliftTimer);
    preliftTimer = null;
  }
  if (!preliftLeaf) {
    return;
  }
  preliftLeaf.classList.remove(PRELIFT_CLASS);
  preliftLeaf = null;
}

// Drop the current peek (and any pending timers) immediately. Pins and
// reveals are untouched — they are meant to survive tab switches.
export function clearNow(): void {
  cancelShow();
  cancelHide();
  clearPrelift();
  if (peekedLeaf) {
    peekedLeaf.classList.remove(PEEK_CLASS);
    beginClosing(peekedLeaf);
  }
  peekedLeaf = null;
}

// Layout changes can detach the elements our lifts sit on — but most layout
// churn (sidebar toggles, a deferred view finishing its load) leaves them
// connected. Drop a lift only when its element is actually gone; clearing on
// every layout-change would kill a live peek while the pointer is still on
// the spine, with no new mouseover to bring it back.
export function clearIfDetached(): void {
  if (peekedLeaf && !peekedLeaf.isConnected) {
    clearNow();
  }
  if (landingLeaf && !landingLeaf.isConnected) {
    releaseLanding();
  }
}

// Drop the landing lift and its fail-safe timer. With animate=true the lift
// eases back through the closing animation instead of popping the shadow off
// in one frame.
function releaseLanding(animate = false): void {
  if (landingTimer !== null) {
    window.clearTimeout(landingTimer);
    landingTimer = null;
  }
  if (landingLeaf) {
    clearPrelift(landingLeaf);
    landingLeaf.classList.remove(PEEK_CLASS);
    if (animate) {
      beginClosing(landingLeaf);
    }
    landingLeaf = null;
  }
}

// The active leaf changed (usually a click). Drop any hover peek — and if the
// newly active pane is still buried under the stack, lift it until the
// scroll-into-view uncovers it. The lift is released by evaluateNow() at the
// exact frame nothing covers the pane anymore, where removing it is visually
// a no-op — so the landing is seamless with no timing guesses.
export function handleActiveLeafChange(activeLeafElement: HTMLElement | null): void {
  const settings = currentSettings;

  if (!activeLeafElement) {
    clearNow();
    releaseLanding();
    return;
  }
  // Activations OUTSIDE the managed deck (sidebar leaves, unstacked groups)
  // must not touch a live peek or landing: the deck scroll that releases them
  // is still running, and cutting the landing mid-scroll re-buries the very
  // pane the user just clicked.
  if (!settings || !isStackingActive(settings)) {
    return;
  }
  if (!isManagedElement(activeLeafElement)) {
    return;
  }

  // Only the current active pane may hold a landing.
  clearNow();
  releaseLanding(true);

  if (!isCoveredByNeighbor(activeLeafElement)) {
    return; // already fully visible; nothing to bridge
  }

  if (closingLeaf === activeLeafElement) {
    finishClosingNow(); // a drop animation was in flight; the landing stays up
  }
  landingLeaf = activeLeafElement;

  // A just-clicked pane is frequently a deferred view that has never rendered,
  // and it is certainly not rasterized — it has been buried under its
  // neighbours the whole time. Load it and promote it to its own layer FIRST,
  // then lift it on the next frame, so the lift reveals painted content
  // instead of a black rectangle that fills in afterwards.
  ensureLeafContentLoaded(activeLeafElement);
  setPrelift(activeLeafElement);
  const view = activeLeafElement.ownerDocument.defaultView ?? window;
  view.requestAnimationFrame(() => {
    if (landingLeaf !== activeLeafElement) {
      return; // released (or replaced) while we waited for the frame
    }
    activeLeafElement.classList.add(PEEK_CLASS);
    schedulePreliftRelease(activeLeafElement); // keep the layer through the grow
  });

  landingTimer = window.setTimeout(() => {
    landingTimer = null;
    releaseLanding(true);
  }, LANDING_MAX_MS);
  reevaluate();
}

// Is any part of this pane painted over by another pane? Derived from
// uncoveredSpan so coverage and the clips are the same rule seen twice — a
// pane counts as covered exactly when the clips would hide part of it.
//
// We compare PAINTED rects on purpose: sticky pins are exactly what cause the
// overlap, so the rects tell the truth. (clip-path does not change an
// element's rects, so this stays correct for revealed and pinned panes too.)
//
// Known limitation: an earlier pane carrying a z-index lift (pinned-engaged,
// z=9) CAN visually overlap this pane's left portion, and we deliberately
// don't count that — treating partial left overlay as "covered" would break
// the reveal-candidate and landing-release logic. Consequence: peeking a pane
// whose left edge sits under an engaged pin is refused until the pin
// disengages. Rare and self-resolving, so accepted.
function isCoveredByNeighbor(leaf: HTMLElement): boolean {
  const { rect, visibleSpan } = measureVisibility(leaf);
  return visibleSpan < rect.width - OVERLAP_EPSILON_PX;
}

// A buried tab that was never activated this session can be a DEFERRED view:
// Obsidian hasn't rendered its content yet, so revealing or lifting it would
// show an empty pane. Ask Obsidian to load it (public API; resolves to a
// no-op when the view is already loaded).
function ensureLeafContentLoaded(leafElement: HTMLElement): void {
  const app = currentApp;
  if (!app) {
    return;
  }
  const leaf = leafForElement(app, leafElement);
  if (leaf && leaf.isDeferred) {
    void leaf.loadIfDeferred();
  }
}

// Pre-render every deferred pane in the managed stacked groups. After an app
// reload EVERY background tab is deferred, so without this each pane hits the
// reveal strip empty — a black strip that fills in while you scroll the deck.
// Loading everything up front is what a sliding-panes stack wants anyway:
// every pane is going to be shown as a strip or peek eventually. Cheap to
// re-run: already-loaded leaves are skipped by the isDeferred check.
function preloadStackedLeaves(app: App): void {
  app.workspace.iterateAllLeaves((leaf) => {
    if (!leaf.isDeferred) {
      return;
    }
    const element = leafEl(leaf);
    if (element && isManagedElement(element)) {
      void leaf.loadIfDeferred();
    }
  });
}

// ---------------------------------------------------------------------------
// Peek (transient hover lift)
// ---------------------------------------------------------------------------

// The show-timer fired: lift the pane, if it's still there and actually buried.
function showPeek(leaf: HTMLElement): void {
  showTimer = null;
  pendingLeaf = null;

  // Whatever happens below, the previous peek comes down: the pointer has
  // moved on to THIS pane, so if this show can't proceed (pane detached,
  // holding the landing, or fully visible) the old lift must not stay up.
  // clearNow also drops the prelift; the success path below re-establishes it
  // for THIS pane in the same task, so the layer never reaches the compositor
  // in a de-promoted state.
  clearNow();

  if (!leaf.isConnected) {
    return;
  }
  if (leaf === landingLeaf) {
    return; // already lifted as the landing pane; peeking it would fight that
  }
  if (!isCoveredByNeighbor(leaf)) {
    return; // fully visible already; lifting it would just flash a shadow
  }

  if (closingLeaf === leaf) {
    finishClosingNow(); // re-peeked while still shrinking; the grow takes over
  }
  // Idempotent, and deliberately NOT awaited: scheduleShow already asked for
  // the load PEEK_SHOW_DELAY_MS ago, so it has almost always finished. If it
  // hasn't, we lift anyway rather than adding unbounded latency to a hover —
  // the view paints itself in a frame or two.
  ensureLeafContentLoaded(leaf);
  leaf.classList.add(PEEK_CLASS);
  peekedLeaf = leaf;
  // Hold the pre-rasterized layer for the length of the grow, then let it go.
  setPrelift(leaf);
  schedulePreliftRelease(leaf);
}

function scheduleShow(leaf: HTMLElement): void {
  cancelShow();
  pendingLeaf = leaf;
  // Treat hover as intent and spend the delay usefully: start constructing a
  // deferred view and rasterize the buried pane NOW, so by the time the lift
  // happens there is real, already-painted content to uncover.
  ensureLeafContentLoaded(leaf);
  setPrelift(leaf);
  showTimer = window.setTimeout(() => {
    showPeek(leaf);
  }, PEEK_SHOW_DELAY_MS);
}

function scheduleHide(): void {
  if (hideTimer !== null) {
    return; // already counting down
  }
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    clearNow();
  }, PEEK_HIDE_DELAY_MS);
}

// Delegated mouseover handler (mouseover bubbles; mouseenter doesn't).
// Popout windows are separate realms, so we duck-type instead of instanceof.
function handleMouseOver(event: MouseEvent): void {
  const settings = currentSettings;
  if (!settings || !isStackingActive(settings) || !settings.hoverPeek) {
    return;
  }

  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== 'function') {
    return;
  }

  // Case 1: hovering a spine → peek its pane.
  const header = target.closest('.workspace-tab-header') as HTMLElement | null;
  if (header && isManagedElement(header)) {
    const leaf = leafForHeader(header);
    if (leaf) {
      cancelHide();
      if (leaf === peekedLeaf) {
        cancelShow(); // already lifted; just keep it up
        return;
      }
      if (leaf !== pendingLeaf) {
        scheduleShow(leaf);
      }
      return;
    }
  }

  // Case 2: hovering inside a pane.
  const leaf = target.closest('.workspace-leaf') as HTMLElement | null;
  if (leaf && isManagedElement(leaf)) {
    if (leaf === peekedLeaf) {
      // Inside the lifted pane: keep the peek up.
      cancelHide();
      cancelShow();
      return;
    }
    if (leaf.classList.contains(REVEAL_CLASS) || leaf.classList.contains(PIN_ENGAGED_CLASS)) {
      // Hovering a revealed strip or a pinned half-pane grows it to full.
      cancelHide();
      if (leaf !== pendingLeaf) {
        scheduleShow(leaf);
      }
      return;
    }
  }

  // Pointer is somewhere else entirely.
  windDownPeek();
}

// The pointer is no longer over anything peek-related: cancel a pending show
// and start the hide countdown for a lifted pane.
function windDownPeek(): void {
  // Read before cancelShow clears it. Only the ABANDONED pane's prelift goes:
  // a peek that is already up may still be mid-grow and needs its layer.
  const abandonedLeaf = pendingLeaf;
  cancelShow();
  if (abandonedLeaf) {
    clearPrelift(abandonedLeaf);
  }
  if (peekedLeaf) {
    scheduleHide();
  }
}

// Pointer left the document (e.g. out of the window): wind the peek down.
function handleDocumentMouseLeave(): void {
  windDownPeek();
}

// ---------------------------------------------------------------------------
// Reveal + pin evaluation (which panes are lifted, and how they're clipped)
// ---------------------------------------------------------------------------

function clearReveal(leaf: HTMLElement): void {
  leaf.classList.remove(REVEAL_CLASS);
  leaf.style.removeProperty(REVEAL_CLIP_LEFT_VAR);
  leaf.style.removeProperty(REVEAL_CLIP_RIGHT_VAR);
  revealedLeaves.delete(leaf);
}

// ---------------------------------------------------------------------------
// The evaluation pass is split into a MEASURE half and an APPLY half.
//
// Reading a rect after writing a class or style forces the browser to re-run
// layout on the spot; doing that in a loop (once per pinned pane, once per
// group) is layout thrashing, and it is what made deck scrolling stutter. So
// every getBoundingClientRect() call happens in the measure functions below,
// which touch nothing, and every class/style write happens in the matching
// apply functions, which measure nothing.
// ---------------------------------------------------------------------------

// What one pinned pane should look like this frame.
interface PinPlan {
  leaf: HTMLElement;
  engaged: boolean;   // pinned AND currently buried
  clipRight: number;  // px hidden on the right while engaged
}

// The reveal strip for one group: which pane carries it and how it is clipped.
interface RevealPlan {
  candidate: HTMLElement;
  clipLeft: number;
  clipRight: number;
}

// One stacked group's measurements: every pane in it (so stale strips can be
// cleared) plus the strip we want, if any.
interface GroupPlan {
  leaves: HTMLElement[];
  reveal: RevealPlan | null;
}

// One measured child of a stacked container. Panes and spines are interleaved
// there and both paint, so the measure pass keeps them in one ordered list.
interface StackedChild {
  element: HTMLElement;
  isPane: boolean; // false = spine (`.workspace-tab-header`)
  rect: PaneRect;
}

// MEASURE: engagement and clip for every pinned pane in this document. Pins in
// other windows belong to those windows' own evaluation passes; the
// disconnected-pane pruning is window-agnostic and happens for all of them.
function measurePins(pinsActive: boolean, doc: Document): PinPlan[] {
  const plans: PinPlan[] = [];
  pinnedLeaves.forEach((leaf) => {
    if (!leaf.isConnected) {
      pinnedLeaves.delete(leaf); // tab closed / rebuilt; the pin dies with it
      return;
    }
    if (!belongsTo(leaf, doc)) {
      return;
    }
    const { rect, visibleSpan } = measureVisibility(leaf);
    const buried = visibleSpan < rect.width - OVERLAP_EPSILON_PX;
    plans.push({
      leaf,
      engaged: pinsActive && buried,
      clipRight: pinClipRightPx(rect, visibleSpan),
    });
  });
  return plans;
}

// APPLY: engage / disengage each pin and keep its clip current. The clip is
// rewritten every pass on purpose — it tracks the deck as it scrolls, so the
// pinned pane always reaches exactly to whatever is covering it right now.
function applyPins(plans: PinPlan[]): void {
  plans.forEach((plan) => {
    plan.leaf.classList.toggle(PIN_ENGAGED_CLASS, plan.engaged);
    if (plan.engaged) {
      setPxVar(plan.leaf, PIN_CLIP_RIGHT_VAR, plan.clipRight);
    } else {
      plan.leaf.style.removeProperty(PIN_CLIP_RIGHT_VAR);
    }
  });
}

// MEASURE: decide the reveal strip for one stacked group — the nearest buried
// pane on the left of the first fully visible pane, clipped so the strip sits
// right after the pinned spines and shows the note's left edge.
function measureGroup(group: TabGroupLike, settings: SlidingPanesSettings, revealActive: boolean): GroupPlan | null {
  const container = getTabContainer(group);
  if (!container) {
    return null;
  }

  // One rect read per stacked child, up front, keeping panes and spines in
  // their real DOM order — coverage depends on that interleaving. Everything
  // below is arithmetic on these; no further DOM access.
  const children: StackedChild[] = [];
  Array.from(container.children).forEach((child) => {
    const element = child as HTMLElement;
    const isPane = element.classList.contains('workspace-leaf');
    const isSpine = element.classList.contains('workspace-tab-header');
    if (!isPane && !isSpine) {
      return;
    }
    children.push({ element, isPane, rect: measurePane(element) });
  });

  const childRects = children.map((child) => child.rect);
  const paneChildIndexes: number[] = [];
  const headerRects: PaneRect[] = [];
  children.forEach((child, index) => {
    if (child.isPane) {
      paneChildIndexes.push(index);
    } else {
      headerRects.push(child.rect);
    }
  });

  const leaves = paneChildIndexes.map((index) => children[index].element);
  const paneRects = paneChildIndexes.map((index) => children[index].rect);
  // Each pane measured against everything painted after it — panes and spines.
  const visibleSpans = paneChildIndexes.map((index) =>
    uncoveredSpan(children[index].rect, childRects.slice(index + 1))
  );

  // The first pane not covered by a neighbour is the leftmost fully visible
  // one; the pane before it (if any) is the nearest left-buried candidate.
  let firstVisibleIndex = -1;
  for (let i = 0; i < leaves.length; i++) {
    const fullyVisible = visibleSpans[i] >= paneRects[i].width - OVERLAP_EPSILON_PX;
    if (fullyVisible) {
      firstVisibleIndex = i;
      break;
    }
  }

  const hasCandidate = revealActive && firstVisibleIndex > 0;
  if (!hasCandidate) {
    return { leaves, reveal: null };
  }

  // Strip geometry, from the painted rects above. The strip starts at the
  // candidate's own left edge — it pins right after the pinned spine block —
  // pushed right past any spine that is pinned over that exact spot (when the
  // first visible pane sits flush against the spines, its own spine pins on
  // top of the candidate's first columns). We must NOT anchor on the first
  // visible pane's spine unconditionally: when scroll-manager parks the active
  // pane past the reveal slot, that spine rides in FLOW at the far end of the
  // slot, and anchoring there would shove the strip out of its slot and over
  // the active pane — while the slot itself sits empty.
  const candidateIndex = firstVisibleIndex - 1;
  const candidateRect = paneRects[candidateIndex];
  let stripStart = candidateRect.left;
  for (let i = 0; i <= firstVisibleIndex && i < headerRects.length; i++) {
    const headerRect = headerRects[i];
    const headerCoversStripStart =
      headerRect.left <= stripStart + OVERLAP_EPSILON_PX && headerRect.right > stripStart;
    if (headerCoversStripStart) {
      stripStart = headerRect.right;
    }
  }

  // Invariant: a reveal is a STRIP — it must always leave the majority of the
  // pane clipped away, or it stops being an edge peek and becomes a whole pane
  // with a drop shadow sitting on top of its right-hand neighbours.
  const widestUsefulStrip = candidateRect.width * MAX_REVEAL_FRACTION;
  const requestedStripWidth = Math.min(settings.edgeRevealWidth, widestUsefulStrip);

  // ...or wider than that, if whatever covers the candidate starts further
  // right. Stopping short of the covering edge would leave a band of bare
  // background between the two, and clipping the pane mid-glyph is exactly what
  // made the strip look like cut-off text. The covering edge is the next SPINE
  // in the normal case, so the strip ends flush against it and never paints
  // over it.
  const coveringEdgeLeft = candidateRect.left + visibleSpans[candidateIndex];
  const stripEnd = Math.max(stripStart + requestedStripWidth, coveringEdgeLeft);

  return {
    leaves,
    reveal: {
      candidate: leaves[candidateIndex],
      clipLeft: Math.max(0, stripStart - candidateRect.left),
      clipRight: Math.max(0, candidateRect.right - stripEnd),
    },
  };
}

// APPLY: put the strip on the chosen pane and take it off everyone else.
function applyGroup(plan: GroupPlan): void {
  const reveal = plan.reveal;
  plan.leaves.forEach((leaf) => {
    const keepsStrip = reveal !== null && leaf === reveal.candidate;
    if (!keepsStrip && revealedLeaves.has(leaf)) {
      clearReveal(leaf);
    }
  });
  if (!reveal) {
    return;
  }

  // An engaged pin already lifts this pane, higher (z=9) and with a clip that
  // reaches the covering pane. Adding the strip on top would only fight it, so
  // the pin wins and the reveal stands down.
  if (reveal.candidate.classList.contains(PIN_ENGAGED_CLASS)) {
    clearReveal(reveal.candidate);
    return;
  }

  // A candidate being revealed for the first time may be an unrendered
  // deferred view; load it so the strip shows real content, not a blank pane.
  if (!revealedLeaves.has(reveal.candidate)) {
    ensureLeafContentLoaded(reveal.candidate);
  }

  reveal.candidate.classList.add(REVEAL_CLASS);
  setPxVar(reveal.candidate, REVEAL_CLIP_LEFT_VAR, reveal.clipLeft);
  setPxVar(reveal.candidate, REVEAL_CLIP_RIGHT_VAR, reveal.clipRight);
  revealedLeaves.add(reveal.candidate);
}

// Strip the peek / closing / prelift classes off any pane in this document
// that has no business carrying them. A stuck lifted pane covers everything
// painted below it and eats the hovers meant for what's underneath, and a
// stuck prelift pins a full-size compositing layer forever — so any stray
// class, left behind by a state path we didn't anticipate, is cleaned up on
// every evaluation. Class queries only; nothing here reads geometry.
function healStrayLifts(doc: Document): void {
  doc.querySelectorAll('.' + PEEK_CLASS).forEach((element) => {
    if (element !== peekedLeaf && element !== landingLeaf) {
      element.classList.remove(PEEK_CLASS);
    }
  });
  doc.querySelectorAll('.' + PEEK_CLOSING_CLASS).forEach((element) => {
    const htmlElement = element as HTMLElement;
    if (htmlElement !== closingLeaf) {
      htmlElement.classList.remove(PEEK_CLOSING_CLASS);
      htmlElement.style.removeProperty(CLOSING_CLIP_LEFT_VAR);
      htmlElement.style.removeProperty(CLOSING_CLIP_RIGHT_VAR);
    }
  });
  doc.querySelectorAll('.' + PRELIFT_CLASS).forEach((element) => {
    if (element !== preliftLeaf) {
      element.classList.remove(PRELIFT_CLASS);
    }
  });
}

// Is this element part of the given document? Popout windows are separate
// documents, and each evaluation pass owns exactly one of them.
function belongsTo(element: HTMLElement | null, doc: Document): boolean {
  return element !== null && element.ownerDocument === doc;
}

// Re-check everything state-dependent in ONE document: which pane carries the
// reveal strip, whether each pinned pane is currently buried, whether the
// landing lift can come down, and where a shrinking pane is heading.
//
// Scoped to a single document because each one runs on its own animation
// frame. A popout evaluating the main window's panes would be pure waste —
// twice the measuring per frame for a result the main window's own pass is
// producing anyway — and it would measure them on the wrong window's clock.
function evaluateNow(doc: Document): void {
  const app = currentApp;
  const settings = currentSettings;
  const stackingActive = !!app && !!settings && isStackingActive(settings);

  // ---- MEASURE (reads only) ------------------------------------------------

  // Landing: the freshly activated pane stays lifted only while something
  // still covers it. The moment it is fully uncovered (the scroll-into-view
  // finished), dropping the lift changes nothing visually.
  const releaseLandingNow =
    landingLeaf !== null &&
    belongsTo(landingLeaf, doc) &&
    (!landingLeaf.isConnected || !stackingActive || !isCoveredByNeighbor(landingLeaf));

  // A pane shrinking back down aims at a destination that was correct when the
  // shrink started. If the deck scrolls during those ~200ms that destination is
  // already wrong, and the pane animates to a clip that no longer matches
  // anything — so re-aim it at CURRENT geometry every pass.
  const shrinkingLeaf =
    closingLeaf &&
    belongsTo(closingLeaf, doc) &&
    closingLeaf.isConnected &&
    closingLeaf.classList.contains(PEEK_CLOSING_CLASS)
      ? closingLeaf
      : null;
  const shrinkDestination = shrinkingLeaf ? closingDestination(shrinkingLeaf) : null;

  const pinsActive = stackingActive && !!settings && settings.pinButtons;
  const pinPlans = measurePins(pinsActive, doc);

  const groupPlans: GroupPlan[] = [];
  if (app && settings) {
    const revealActive = stackingActive && settings.edgeReveal;
    getRootTabGroups(app).forEach((group) => {
      if (!isStacked(group) || group.containerEl.ownerDocument !== doc) {
        return;
      }
      const plan = measureGroup(group, settings, revealActive);
      if (plan) {
        groupPlans.push(plan);
      }
    });
  }

  // ---- APPLY (writes only) -------------------------------------------------

  if (shrinkingLeaf && shrinkDestination) {
    const leftMoved = setPxVar(shrinkingLeaf, CLOSING_CLIP_LEFT_VAR, shrinkDestination.left);
    const rightMoved = setPxVar(shrinkingLeaf, CLOSING_CLIP_RIGHT_VAR, shrinkDestination.right);
    if (leftMoved || rightMoved) {
      // The target moved, so the CSS transition just restarted from wherever
      // the clip currently is. Give it a full window to converge again — the
      // class may only drop once the destination has held still.
      restartClosingTimer();
    }
  }

  applyPins(pinPlans);

  // Drop reveal bookkeeping for panes that no longer exist, then re-plan.
  revealedLeaves.forEach((leaf) => {
    if (!leaf.isConnected) {
      revealedLeaves.delete(leaf);
    }
  });
  groupPlans.forEach(applyGroup);

  healStrayLifts(doc);

  // Last, because releasing a landing starts a closing animation, and that
  // needs to measure the pane's resting clip AFTER the pin/reveal writes above
  // have settled. One forced layout, once per landing — not per frame.
  if (releaseLandingNow) {
    releaseLanding(true);
  }
}

// Queue one evaluation of ONE document on that document's next animation
// frame. A popout window animates on its own clock, and when the main window
// is occluded its rAF is throttled to near-zero — a shared latch or a shared
// frame callback would leave popout clips frozen at stale geometry.
function scheduleEvaluation(doc: Document): void {
  if (documentsWithQueuedEvaluation.has(doc)) {
    return;
  }
  const view = doc.defaultView;
  if (!view) {
    documentsWithQueuedEvaluation.delete(doc); // window closed; nothing to run
    return;
  }
  documentsWithQueuedEvaluation.add(doc);
  view.requestAnimationFrame(() => {
    documentsWithQueuedEvaluation.delete(doc);
    evaluateNow(doc);
  });
}

// Public entry: evaluate every attached document on its own next frame,
// coalescing bursts (scroll events, resize storms) into one pass each.
export function reevaluate(): void {
  const documents = attachedDocuments.length > 0 ? attachedDocuments : [document];
  documents.forEach(scheduleEvaluation);
}

// One extra pass a frame later than the next one. Obsidian recomputes its own
// stacked-tab sticky offsets in a layout pass that can land AFTER ours, so the
// geometry the immediate evaluation measures is the pre-change geometry. The
// double frame puts this pass after that, and the equality guards on every
// style write make it nearly free when nothing actually moved.
export function reevaluateAfterLayoutSettles(): void {
  attachedDocuments.forEach((doc) => {
    const view = doc.defaultView;
    if (!view) {
      return;
    }
    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => {
        scheduleEvaluation(doc);
      });
    });
  });
}

// Capture-phase scroll handler ('scroll' doesn't bubble): the deck scrolling
// is exactly when panes cross between buried and fully visible. Only the tab
// container's own (horizontal) scroll matters — vertical scrolling inside an
// editor can't change which panes are buried, so skip it.
function handleScrollCapture(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (!target || !target.classList || !target.classList.contains('workspace-tab-container')) {
    return;
  }
  reevaluate();
}

// ---------------------------------------------------------------------------
// Pin buttons
// ---------------------------------------------------------------------------

// Set or clear a pane's pin, syncing the spine button if it currently exists
// (headers get rebuilt on layout changes, so it may be absent right now).
function setPinned(leaf: HTMLElement, pinned: boolean): void {
  leaf.classList.toggle(PIN_STATE_CLASS, pinned);

  const header = leaf.previousElementSibling as HTMLElement | null;
  if (header && header.classList.contains('workspace-tab-header')) {
    const button = header.querySelector('.' + PIN_BUTTON_CLASS);
    if (button) {
      button.classList.toggle(PIN_BUTTON_ON_CLASS, pinned);
    }
  }

  if (pinned) {
    pinnedLeaves.add(leaf);
    ensureLeafContentLoaded(leaf);
  } else {
    pinnedLeaves.delete(leaf);
    leaf.classList.remove(PIN_ENGAGED_CLASS);
    leaf.style.removeProperty(PIN_CLIP_RIGHT_VAR);
  }
  reevaluate();
}

function togglePin(header: HTMLElement): void {
  const leaf = leafForHeader(header);
  if (!leaf) {
    return;
  }
  setPinned(leaf, !leaf.classList.contains(PIN_STATE_CLASS));
}

// Command entry: pin/unpin the pane that currently has focus. Exists because
// the spine pin button only fades in on hover — unreachable on touch screens
// and for keyboard / command-palette users.
export function togglePinForActiveLeaf(app: App, settings: SlidingPanesSettings): void {
  if (!isStackingActive(settings) || !settings.pinButtons) {
    new Notice('Sliding Panes: pinning needs Stacking and Pin Buttons enabled.');
    return;
  }
  const activeLeaf = app.workspace.getMostRecentLeaf();
  const element = activeLeaf ? leafEl(activeLeaf) : null;
  if (!element || !isManagedElement(element)) {
    return;
  }
  setPinned(element, !element.classList.contains(PIN_STATE_CLASS));
}

// Give every managed spine a pin button (idempotent). Buttons are created in
// the header's own document — popouts are separate realms.
function injectPinButtons(app: App): void {
  const groups = getRootTabGroups(app);
  groups.forEach((group: TabGroupLike) => {
    if (!isStacked(group)) {
      return;
    }
    const headers = group.containerEl.querySelectorAll('.workspace-tab-header');
    headers.forEach((headerNode) => {
      const header = headerNode as HTMLElement;
      if (!isManagedElement(header)) {
        return;
      }
      if (header.querySelector('.' + PIN_BUTTON_CLASS)) {
        return; // already has one
      }
      const leaf = leafForHeader(header);
      if (!leaf) {
        return;
      }

      const button = header.ownerDocument.createElement('div');
      button.className = PIN_BUTTON_CLASS;
      button.setAttribute('aria-label', 'Pin: keep this pane half-visible while buried');
      setIcon(button, 'pin');
      // Reflect existing pin state (headers get rebuilt on layout changes
      // while the leaf element — and its class — survives).
      if (leaf.classList.contains(PIN_STATE_CLASS)) {
        button.classList.add(PIN_BUTTON_ON_CLASS);
        pinnedLeaves.add(leaf);
      }

      // The header itself activates the tab (on pointer/mouse down and click)
      // and is a drag handle; the button must swallow all of those so a
      // pin-click is ONLY a pin.
      button.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        event.preventDefault();
      });
      button.addEventListener('mousedown', (event) => {
        event.stopPropagation();
        event.preventDefault();
      });
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        togglePin(header);
      });

      header.appendChild(button);
    });
  });
}

// Remove every pin button and pin class, everywhere. Shared by full artifact
// removal below and by attach() when the pin feature is toggled off.
function removePinArtifacts(): void {
  attachedDocuments.forEach((doc) => {
    doc.querySelectorAll('.' + PIN_BUTTON_CLASS).forEach((button) => button.remove());
    doc.querySelectorAll('.' + PIN_STATE_CLASS).forEach((leafNode) => {
      const leaf = leafNode as HTMLElement;
      leaf.classList.remove(PIN_STATE_CLASS);
      leaf.classList.remove(PIN_ENGAGED_CLASS);
      leaf.style.removeProperty(PIN_CLIP_RIGHT_VAR);
    });
  });
  pinnedLeaves.clear();
}

// Remove every pin button and pin/reveal/prelift class we ever added,
// everywhere.
function removeLiftArtifacts(): void {
  removePinArtifacts();
  clearPrelift(); // also cancels the pending prelift-release timer
  attachedDocuments.forEach((doc) => {
    doc.querySelectorAll('.' + REVEAL_CLASS).forEach((leaf) => {
      clearReveal(leaf as HTMLElement);
    });
    doc.querySelectorAll('.' + PRELIFT_CLASS).forEach((leaf) => {
      leaf.classList.remove(PRELIFT_CLASS);
    });
  });
  revealedLeaves.clear();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Watch every stacked tab container for size changes. Obsidian's own resize
// event and layout-change between them miss a whole class of geometry shifts:
// switching theme, editing a CSS snippet, changing the interface font size,
// dragging a sidebar divider. Those move the panes without telling us, and the
// clips would keep the geometry from before.
function observeContainerSizes(app: App): void {
  // Drop observers for containers that were destroyed (closed group or window).
  containerResizeObservers.forEach((observer, container) => {
    if (!container.isConnected) {
      observer.disconnect();
      containerResizeObservers.delete(container);
    }
  });

  getRootTabGroups(app).forEach((group) => {
    if (!isStacked(group)) {
      return;
    }
    const container = getTabContainer(group);
    if (!container || containerResizeObservers.has(container)) {
      return;
    }
    // Popout windows are separate realms; build the observer from the
    // container's OWN window so it observes on that window's frame clock.
    const view = container.ownerDocument.defaultView;
    if (!view || typeof view.ResizeObserver !== 'function') {
      return;
    }
    const observer = new view.ResizeObserver(() => {
      reevaluate();
    });
    observer.observe(container);
    containerResizeObservers.set(container, observer);
  });
}

// Stop watching every container. Called when stacking is switched off (a live
// observer would keep firing evaluations for a feature set that is no longer
// running) and on detach.
function disconnectContainerObservers(): void {
  containerResizeObservers.forEach((observer) => observer.disconnect());
  containerResizeObservers.clear();
}

// Add our delegated listeners + pin buttons to every workspace document.
// Idempotent — safe to call again after layout changes to pick up newly
// opened popout windows and freshly rebuilt spines.
export function attach(app: App, settings: SlidingPanesSettings): void {
  currentApp = app;
  currentSettings = settings;

  // Prune documents whose window has closed (their listeners died with them).
  // The queued-evaluation latch is pruned the same way: a document whose
  // window closed between being latched and its frame callback running would
  // never clear its own entry, and the Set would hold the dead document — and
  // its whole DOM — alive for the rest of the session.
  attachedDocuments = attachedDocuments.filter((doc) => doc.defaultView !== null);
  documentsWithQueuedEvaluation.forEach((doc) => {
    if (doc.defaultView === null) {
      documentsWithQueuedEvaluation.delete(doc);
    }
  });

  const documents = collectDocuments(app);
  documents.forEach((doc) => {
    if (attachedDocuments.includes(doc)) {
      return;
    }
    doc.addEventListener('mouseover', handleMouseOver);
    doc.addEventListener('mouseleave', handleDocumentMouseLeave);
    doc.addEventListener('scroll', handleScrollCapture, true);
    attachedDocuments.push(doc);
  });

  // Pin buttons only exist in stacking mode: their styling is keyed off the
  // stacking body class, and pins can never engage in slide-off mode anyway.
  if (isStackingActive(settings) && settings.pinButtons) {
    injectPinButtons(app);
  } else {
    removePinArtifacts();
  }

  if (isStackingActive(settings)) {
    observeContainerSizes(app);
    // Deferred panes only ever appear when the layout changes — never from
    // plain scrolling — and attach() runs on enable, on every layout-change,
    // and on every settings refresh. That makes this the right (and only)
    // place to preload them; the per-frame evaluation must stay free of it.
    preloadStackedLeaves(app);
  } else {
    disconnectContainerObservers();
  }

  reevaluate();
}

// Remove every listener, button, and class we own. Called on disable/unload.
export function detach(): void {
  removeLiftArtifacts();
  disconnectContainerObservers();
  attachedDocuments.forEach((doc) => {
    doc.removeEventListener('mouseover', handleMouseOver);
    doc.removeEventListener('mouseleave', handleDocumentMouseLeave);
    doc.removeEventListener('scroll', handleScrollCapture, true);
  });
  attachedDocuments = [];
  documentsWithQueuedEvaluation.clear();
  clearNow();
  finishClosingNow(); // no shrink animation should outlive the plugin
  releaseLanding();
  currentApp = null;
  currentSettings = null;
}
