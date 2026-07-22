import { App, setIcon } from 'obsidian';
import { SlidingPanesSettings } from './settings';
import { collectDocuments, getRootTabGroups, getTabContainer, isStacked, TabGroupLike } from './adapter';

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
const REVEAL_CLASS = 'sliding-panes-reveal';
const PIN_STATE_CLASS = 'sliding-panes-pinned';        // leaf: user pinned it
const PIN_ENGAGED_CLASS = 'sliding-panes-pin-engaged'; // leaf: pinned AND buried → lifted half-out
const PIN_BUTTON_CLASS = 'sliding-panes-pin-button';   // the spine button
const PIN_BUTTON_ON_CLASS = 'is-pinned';               // button state modifier

// Inline CSS variables carrying the reveal strip's clip geometry.
const REVEAL_CLIP_LEFT_VAR = '--sp-reveal-left';
const REVEAL_CLIP_RIGHT_VAR = '--sp-reveal-right';

// Hover this long before lifting, so sweeping the mouse across the spines
// doesn't flash panes up and down.
const PEEK_SHOW_DELAY_MS = 300;

// Grace period after the pointer leaves, so crossing a few pixels of gap
// between the spine and the lifted pane doesn't drop the peek.
const PEEK_HIDE_DELAY_MS = 250;

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

// The leaf whose show-timer is pending, and the currently lifted (peeked) leaf.
let pendingLeaf: HTMLElement | null = null;
let peekedLeaf: HTMLElement | null = null;

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

// Drop the current peek (and any pending timers) immediately. Pins and
// reveals are untouched — they are meant to survive tab switches.
export function clearNow(): void {
  cancelShow();
  cancelHide();
  if (peekedLeaf) {
    peekedLeaf.classList.remove(PEEK_CLASS);
  }
  peekedLeaf = null;
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

// Is any part of this pane painted over by a neighboring pane? Only the
// adjacent sibling panes can start an overlap (they pin closest), so checking
// prev/next is sufficient. We compare PAINTED rects on purpose: sticky pins
// are exactly what cause the overlap, so the rects tell the truth here.
// (clip-path does not change an element's rects, so this stays correct for
// revealed and pinned panes too.)
function isCoveredByNeighbor(leaf: HTMLElement): boolean {
  const leafRect = leaf.getBoundingClientRect();

  let next = leaf.nextElementSibling;
  while (next && !next.classList.contains('workspace-leaf')) {
    next = next.nextElementSibling;
  }
  if (next) {
    const nextRect = next.getBoundingClientRect();
    if (nextRect.left < leafRect.right - OVERLAP_EPSILON_PX) {
      return true;
    }
  }

  let previous = leaf.previousElementSibling;
  while (previous && !previous.classList.contains('workspace-leaf')) {
    previous = previous.previousElementSibling;
  }
  if (previous) {
    const previousRect = previous.getBoundingClientRect();
    if (previousRect.right > leafRect.left + OVERLAP_EPSILON_PX) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Peek (transient hover lift)
// ---------------------------------------------------------------------------

// The show-timer fired: lift the pane, if it's still there and actually buried.
function showPeek(leaf: HTMLElement): void {
  showTimer = null;
  pendingLeaf = null;

  if (!leaf.isConnected) {
    return;
  }
  if (!isCoveredByNeighbor(leaf)) {
    return; // fully visible already; lifting it would just flash a shadow
  }

  clearNow();
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

  // Strip geometry, from painted rects: it starts where the left spine block
  // ends — the right edge of the first visible pane's own spine. The buried
  // pane is pinned exactly there, so the clip normally starts at its column 0
  // (the note's left edge); we still compute it for robustness.
  const anchorHeader = headers[firstVisibleIndex] ?? null;
  const candidateRect = candidate.getBoundingClientRect();
  const stripStart = anchorHeader ? anchorHeader.getBoundingClientRect().right : candidateRect.left;

  const clipLeft = Math.max(0, stripStart - candidateRect.left);
  const clipRight = Math.max(0, candidateRect.width - clipLeft - settings.edgeRevealWidth);

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

function togglePin(header: HTMLElement, button: HTMLElement): void {
  const leaf = leafForHeader(header);
  if (!leaf) {
    return;
  }

  const nowPinned = leaf.classList.toggle(PIN_STATE_CLASS);
  button.classList.toggle(PIN_BUTTON_ON_CLASS, nowPinned);
  if (nowPinned) {
    pinnedLeaves.add(leaf);
  } else {
    pinnedLeaves.delete(leaf);
    leaf.classList.remove(PIN_ENGAGED_CLASS);
  }
  reevaluate();
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
        togglePin(header, button);
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
  currentApp = null;
  currentSettings = null;
}
