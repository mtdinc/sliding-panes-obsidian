import { App, Notice, setIcon } from 'obsidian';
import { SlidingPanesSettings } from './settings';
import { collectDocuments, getRootTabGroups, getTabContainer, isStacked, leafEl, leafForElement, TabGroupLike } from './adapter';

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
//  edgeRevealWidth. width-manager reserves room for the strip when panes
//  overflow, so it usually occupies its own space rather than covering the
//  active pane. Re-evaluated on every deck scroll / resize / layout change.
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

// Inline CSS variables carrying the reveal strip's clip geometry.
const REVEAL_CLIP_LEFT_VAR = '--sp-reveal-left';
const REVEAL_CLIP_RIGHT_VAR = '--sp-reveal-right';

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

// How long the closing class stays on a pane after its peek drops. Slightly
// longer than the CSS transition (200ms) so the shrink finishes animating.
const PEEK_CLOSING_MS = 250;

// Painted rects closer than this are treated as touching, not overlapping
// (integer width rounding can leave a stray pixel).
const OVERLAP_EPSILON_PX = 2;

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

// An evaluation is already queued for the next animation frame.
let evalQueued = false;

function cancelShow(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  pendingLeaf = null;
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

// The next `.workspace-leaf` sibling after this element, or null. In stacked
// mode the container interleaves headers and leaves, so skip non-leaves.
function nextLeafSibling(element: HTMLElement): HTMLElement | null {
  let next = element.nextElementSibling;
  while (next && !next.classList.contains('workspace-leaf')) {
    next = next.nextElementSibling;
  }
  return next as HTMLElement | null;
}

// Where does this pane's clip end up once the lift is fully gone? The closing
// animation holds the pane at peek z-index and shrinks its clip to exactly
// this destination, so dropping the closing class afterwards changes nothing
// on screen — no snap, no shadow pop.
function closingDestination(leaf: HTMLElement): { left: number; right: number } {
  if (leaf.classList.contains(REVEAL_CLASS)) {
    // Falling back to the reveal strip: reuse its exact clip.
    const left = parseFloat(leaf.style.getPropertyValue(REVEAL_CLIP_LEFT_VAR)) || 0;
    const right = parseFloat(leaf.style.getPropertyValue(REVEAL_CLIP_RIGHT_VAR)) || 0;
    return { left, right };
  }
  if (leaf.classList.contains(PIN_ENGAGED_CLASS)) {
    // Falling back to the pinned left half.
    return { left: 0, right: leaf.getBoundingClientRect().width / 2 };
  }
  // Plain buried pane: the next pane covers everything from its own left edge
  // rightward. What survives the clip is exactly the sliver that stays
  // visible naturally, so the handoff is seamless.
  const next = nextLeafSibling(leaf);
  if (next) {
    const covered = leaf.getBoundingClientRect().right - next.getBoundingClientRect().left;
    return { left: 0, right: Math.max(0, covered) };
  }
  return { left: 0, right: 0 };
}

// Hold the closing class on a pane briefly so the CSS transition can animate
// its clip back down to its resting state instead of snapping.
function beginClosing(leaf: HTMLElement): void {
  finishClosingNow();
  if (leaf.isConnected) {
    const destination = closingDestination(leaf);
    leaf.style.setProperty(CLOSING_CLIP_LEFT_VAR, destination.left + 'px');
    leaf.style.setProperty(CLOSING_CLIP_RIGHT_VAR, destination.right + 'px');
  }
  closingLeaf = leaf;
  leaf.classList.add(PEEK_CLOSING_CLASS);
  closingTimer = window.setTimeout(() => {
    closingTimer = null;
    finishClosingNow();
  }, PEEK_CLOSING_MS);
}

// Drop the current peek (and any pending timers) immediately. Pins and
// reveals are untouched — they are meant to survive tab switches.
export function clearNow(): void {
  cancelShow();
  cancelHide();
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
  if (!settings || settings.disabled || !settings.stackingEnabled) {
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
  activeLeafElement.classList.add(PEEK_CLASS);
  landingTimer = window.setTimeout(() => {
    landingTimer = null;
    releaseLanding(true);
  }, LANDING_MAX_MS);
  reevaluate();
}

// Is this element inside a stacked tab group in a root workspace area (main
// window or popout), not a sidebar.
function isManagedElement(element: HTMLElement): boolean {
  const inStackedGroup = element.closest('.workspace-tabs.mod-stacked') !== null;
  const inRootArea = element.closest('.mod-root') !== null;
  return inStackedGroup && inRootArea;
}

// The pane belonging to a spine. In stacked mode the container interleaves
// header and leaf elements, so the pane is the spine's next element sibling.
function leafForHeader(header: HTMLElement): HTMLElement | null {
  const sibling = header.nextElementSibling as HTMLElement | null;
  if (sibling && sibling.classList.contains('workspace-leaf')) {
    return sibling;
  }
  return null;
}

// Is any part of this pane painted over by another pane? Stacked panes paint
// in DOM order with no inline z-index, so only a LATER sibling can paint over
// this one; an EARLIER pane's sticky rect often extends underneath (the rects
// overlap) but it is painted below, never covering. Checking the adjacent next
// pane is sufficient — it pins closest. We compare PAINTED rects on purpose:
// sticky pins are exactly what cause the overlap, so the rects tell the truth.
// (clip-path does not change an element's rects, so this stays correct for
// revealed and pinned panes too.)
//
// Known limitation: an earlier pane carrying a z-index lift (pinned-engaged,
// z=9) CAN visually overlap this pane's left portion, and we deliberately
// don't count that — treating partial left overlay as "covered" would break
// the reveal-candidate and landing-release logic. Consequence: peeking a pane
// whose left edge sits under an engaged pin is refused until the pin
// disengages. Rare and self-resolving, so accepted.
function isCoveredByNeighbor(leaf: HTMLElement): boolean {
  const leafRect = leaf.getBoundingClientRect();

  const next = nextLeafSibling(leaf);
  if (next) {
    const nextRect = next.getBoundingClientRect();
    if (nextRect.left < leafRect.right - OVERLAP_EPSILON_PX) {
      return true;
    }
  }

  return false;
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
  ensureLeafContentLoaded(leaf);
  leaf.classList.add(PEEK_CLASS);
  peekedLeaf = leaf;
}

function scheduleShow(leaf: HTMLElement): void {
  cancelShow();
  pendingLeaf = leaf;
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
  if (!settings || settings.disabled || !settings.stackingEnabled || !settings.hoverPeek) {
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
  cancelShow();
  if (peekedLeaf) {
    scheduleHide();
  }
}

// Pointer left the document (e.g. out of the window): wind the peek down.
function handleDocumentMouseLeave(): void {
  cancelShow();
  if (peekedLeaf) {
    scheduleHide();
  }
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

// Decide the reveal strip for one stacked group: the nearest buried pane on
// the left of the first fully visible pane, clipped so the strip sits right
// after the pinned spines and shows the note's left edge.
function evaluateGroupReveal(group: TabGroupLike, settings: SlidingPanesSettings, revealActive: boolean): void {
  const container = getTabContainer(group);
  if (!container) {
    return;
  }

  const leaves: HTMLElement[] = [];
  const headers: HTMLElement[] = [];
  Array.from(container.children).forEach((child) => {
    const element = child as HTMLElement;
    if (element.classList.contains('workspace-leaf')) {
      leaves.push(element);
    } else if (element.classList.contains('workspace-tab-header')) {
      headers.push(element);
    }
  });

  // The first pane not covered by a neighbor is the leftmost fully visible
  // one; the pane before it (if any) is the nearest left-buried candidate.
  let firstVisibleIndex = -1;
  for (let i = 0; i < leaves.length; i++) {
    if (!isCoveredByNeighbor(leaves[i])) {
      firstVisibleIndex = i;
      break;
    }
  }

  let candidate: HTMLElement | null = null;
  if (revealActive && firstVisibleIndex > 0) {
    candidate = leaves[firstVisibleIndex - 1];
  }

  leaves.forEach((leaf) => {
    if (leaf !== candidate && revealedLeaves.has(leaf)) {
      clearReveal(leaf);
    }
  });
  if (!candidate) {
    return;
  }

  // Strip geometry, from painted rects. The strip starts at the candidate's
  // own left edge — it pins right after the pinned spine block — pushed right
  // past any spine that is pinned over that exact spot (when the first visible
  // pane sits flush against the spines, its own spine pins on top of the
  // candidate's first columns). We must NOT anchor on the first visible pane's
  // spine unconditionally: when scroll-manager parks the active pane past the
  // reveal slot, that spine rides in FLOW at the far end of the slot, and
  // anchoring there would shove the strip out of its slot and over the active
  // pane — while the slot itself sits empty.
  const candidateRect = candidate.getBoundingClientRect();
  let stripStart = candidateRect.left;
  for (let i = 0; i <= firstVisibleIndex && i < headers.length; i++) {
    const headerRect = headers[i].getBoundingClientRect();
    const headerCoversStripStart =
      headerRect.left <= stripStart + OVERLAP_EPSILON_PX && headerRect.right > stripStart;
    if (headerCoversStripStart) {
      stripStart = headerRect.right;
    }
  }

  const clipLeft = Math.max(0, stripStart - candidateRect.left);
  const clipRight = Math.max(0, candidateRect.width - clipLeft - settings.edgeRevealWidth);

  // A candidate being revealed for the first time may be an unrendered
  // deferred view; load it so the strip shows real content, not a blank pane.
  if (!revealedLeaves.has(candidate)) {
    ensureLeafContentLoaded(candidate);
  }

  candidate.classList.add(REVEAL_CLASS);
  candidate.style.setProperty(REVEAL_CLIP_LEFT_VAR, clipLeft + 'px');
  candidate.style.setProperty(REVEAL_CLIP_RIGHT_VAR, clipRight + 'px');
  revealedLeaves.add(candidate);
}

// Re-check everything state-dependent: which pane carries the reveal strip,
// and whether each pinned pane is currently buried (engaged) or not.
function evaluateNow(): void {
  const app = currentApp;
  const settings = currentSettings;
  const stackingActive = !!app && !!settings && !settings.disabled && settings.stackingEnabled;

  // Landing: the freshly activated pane stays lifted only while something
  // still covers it. The moment it is fully uncovered (the scroll-into-view
  // finished), dropping the lift changes nothing visually.
  if (landingLeaf) {
    const shouldRelease =
      !landingLeaf.isConnected || !stackingActive || !isCoveredByNeighbor(landingLeaf);
    if (shouldRelease) {
      releaseLanding(true);
    }
  }

  // Self-heal: no pane may carry the peek class except the current peek or
  // landing. A stuck lifted pane covers everything painted below it and eats
  // the hovers meant for what's underneath, so any stray class — left behind
  // by a state path we didn't anticipate — is stripped here, on every
  // scroll/layout/resize evaluation.
  attachedDocuments.forEach((doc) => {
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
  });

  // Self-heal: never let a deferred (unrendered) pane sit in a stacked group.
  // The attach-time preload covers the normal path, but if any timing window
  // slips past it a pane shows up as a big blank rectangle; this closes that
  // for good. Cheap: already-loaded leaves fail the isDeferred check.
  if (stackingActive && app) {
    preloadStackedLeaves(app);
  }

  // Pins: engaged only while actually buried.
  const pinsActive = stackingActive && !!settings && settings.pinButtons;
  pinnedLeaves.forEach((leaf) => {
    if (!leaf.isConnected) {
      pinnedLeaves.delete(leaf); // tab closed / rebuilt; the pin dies with it
      return;
    }
    const engaged = pinsActive && isCoveredByNeighbor(leaf);
    leaf.classList.toggle(PIN_ENGAGED_CLASS, engaged);
  });

  // Reveals: at most one strip per stacked group.
  revealedLeaves.forEach((leaf) => {
    if (!leaf.isConnected) {
      revealedLeaves.delete(leaf);
    }
  });
  if (!app || !settings) {
    return;
  }
  const revealActive = stackingActive && settings.edgeReveal;
  const groups = getRootTabGroups(app);
  groups.forEach((group) => {
    if (!isStacked(group)) {
      return;
    }
    evaluateGroupReveal(group, settings, revealActive);
  });
}

// Public entry: evaluate on the next animation frame, coalescing bursts
// (scroll events, resize storms) into one pass.
export function reevaluate(): void {
  if (evalQueued) {
    return;
  }
  evalQueued = true;
  window.requestAnimationFrame(() => {
    evalQueued = false;
    evaluateNow();
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
  if (settings.disabled || !settings.stackingEnabled || !settings.pinButtons) {
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

// Remove every pin button and pin/reveal class we ever added, everywhere.
function removeLiftArtifacts(): void {
  attachedDocuments.forEach((doc) => {
    doc.querySelectorAll('.' + PIN_BUTTON_CLASS).forEach((button) => button.remove());
    doc.querySelectorAll('.' + PIN_STATE_CLASS).forEach((leaf) => {
      leaf.classList.remove(PIN_STATE_CLASS);
      leaf.classList.remove(PIN_ENGAGED_CLASS);
    });
    doc.querySelectorAll('.' + REVEAL_CLASS).forEach((leaf) => {
      clearReveal(leaf as HTMLElement);
    });
  });
  pinnedLeaves.clear();
  revealedLeaves.clear();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Add our delegated listeners + pin buttons to every workspace document.
// Idempotent — safe to call again after layout changes to pick up newly
// opened popout windows and freshly rebuilt spines.
export function attach(app: App, settings: SlidingPanesSettings): void {
  currentApp = app;
  currentSettings = settings;

  // Prune documents whose window has closed (their listeners died with them).
  attachedDocuments = attachedDocuments.filter((doc) => doc.defaultView !== null);

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
  // Pre-render deferred panes whenever any lift feature can show them.
  const liftsActive = !settings.disabled && settings.stackingEnabled
    && (settings.edgeReveal || settings.hoverPeek || settings.pinButtons);
  if (liftsActive) {
    preloadStackedLeaves(app);
  }

  if (settings.pinButtons && settings.stackingEnabled) {
    injectPinButtons(app);
  } else {
    attachedDocuments.forEach((doc) => {
      doc.querySelectorAll('.' + PIN_BUTTON_CLASS).forEach((button) => button.remove());
      doc.querySelectorAll('.' + PIN_STATE_CLASS).forEach((leaf) => {
        leaf.classList.remove(PIN_STATE_CLASS);
        leaf.classList.remove(PIN_ENGAGED_CLASS);
      });
    });
    pinnedLeaves.clear();
  }
  reevaluate();
}

// Remove every listener, button, and class we own. Called on disable/unload.
export function detach(): void {
  removeLiftArtifacts();
  attachedDocuments.forEach((doc) => {
    doc.removeEventListener('mouseover', handleMouseOver);
    doc.removeEventListener('mouseleave', handleDocumentMouseLeave);
    doc.removeEventListener('scroll', handleScrollCapture, true);
  });
  attachedDocuments = [];
  clearNow();
  finishClosingNow(); // no shrink animation should outlive the plugin
  releaseLanding();
  currentApp = null;
  currentSettings = null;
}
