import { App } from 'obsidian';
import { SlidingPanesSettings } from './settings';
import { collectDocuments } from './adapter';

// ---------------------------------------------------------------------------
// peek-manager.ts is the SOLE owner of "hover a spine to peek at its pane".
//
// In stacking mode a buried pane still exists at full width in the DOM — it is
// only painted underneath its later siblings (native stacked tabs use equal
// z-index and DOM order, no inline z-index). So a peek is cheap: add a class
// that raises the pane's z-index and it lifts above the stack in place, still
// pinned by its own sticky offset. No scrolling, no layout shift, no cloning.
//
// Flow: hover a spine for PEEK_SHOW_DELAY_MS and its pane lifts (only if it is
// actually covered by a neighbor). The peek stays while the pointer is over
// the spine or the lifted pane, and drops PEEK_HIDE_DELAY_MS after the pointer
// leaves both. Clicking a spine activates the tab as usual; main.ts calls
// clearNow() on active-leaf-change so the lifted look doesn't linger.
// ---------------------------------------------------------------------------

// The class styles.scss keys the lift + shadow off.
const PEEK_CLASS = 'sliding-panes-peek';

// Hover this long before lifting, so sweeping the mouse across the spines
// doesn't flash panes up and down.
const PEEK_SHOW_DELAY_MS = 300;

// Grace period after the pointer leaves, so crossing a few pixels of gap
// between the spine and the lifted pane doesn't drop the peek.
const PEEK_HIDE_DELAY_MS = 250;

// Painted rects closer than this are treated as touching, not overlapping
// (integer width rounding can leave a stray pixel).
const OVERLAP_EPSILON_PX = 2;

// Live settings reference, set by attach(). Handlers read it at event time so
// settings toggles take effect without re-registering anything.
let currentSettings: SlidingPanesSettings | null = null;

// Documents we've added our delegated listeners to (main window + popouts).
let attachedDocuments: Document[] = [];

let showTimer: number | null = null;
let hideTimer: number | null = null;

// The spine whose show-timer is pending, and the currently lifted pane.
let pendingHeader: HTMLElement | null = null;
let peekedHeader: HTMLElement | null = null;
let peekedLeaf: HTMLElement | null = null;

function cancelShow(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  pendingHeader = null;
}

function cancelHide(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}

// Drop the current peek (and any pending timers) immediately.
export function clearNow(): void {
  cancelShow();
  cancelHide();
  if (peekedLeaf) {
    peekedLeaf.classList.remove(PEEK_CLASS);
  }
  peekedLeaf = null;
  peekedHeader = null;
}

// Is this spine one of ours: inside a stacked tab group in a root workspace
// area (main window or popout), not a sidebar.
function isManagedSpine(header: HTMLElement): boolean {
  const inStackedGroup = header.closest('.workspace-tabs.mod-stacked') !== null;
  const inRootArea = header.closest('.mod-root') !== null;
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

// The show-timer fired: lift the pane, if it's still there and actually buried.
function showPeek(header: HTMLElement): void {
  showTimer = null;
  pendingHeader = null;

  if (!header.isConnected) {
    return;
  }
  const leaf = leafForHeader(header);
  if (!leaf) {
    return;
  }
  if (!isCoveredByNeighbor(leaf)) {
    return; // fully visible already; lifting it would just flash a shadow
  }

  clearNow();
  leaf.classList.add(PEEK_CLASS);
  peekedHeader = header;
  peekedLeaf = leaf;
}

function scheduleShow(header: HTMLElement): void {
  cancelShow();
  pendingHeader = header;
  showTimer = window.setTimeout(() => {
    showPeek(header);
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

  const header = target.closest('.workspace-tab-header') as HTMLElement | null;
  if (header && isManagedSpine(header)) {
    cancelHide();
    if (header === peekedHeader) {
      cancelShow(); // already lifted; just keep it up
      return;
    }
    if (header !== pendingHeader) {
      scheduleShow(header);
    }
    return;
  }

  if (peekedLeaf && peekedLeaf.contains(target)) {
    // Pointer is inside the lifted pane: keep the peek up.
    cancelHide();
    cancelShow();
    return;
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

// Add our delegated listeners to every workspace document. Idempotent — safe
// to call again after layout changes to pick up newly opened popout windows.
export function attach(app: App, settings: SlidingPanesSettings): void {
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
    attachedDocuments.push(doc);
  });
}

// Remove every listener and any active peek. Called on disable and unload.
export function detach(): void {
  attachedDocuments.forEach((doc) => {
    doc.removeEventListener('mouseover', handleMouseOver);
    doc.removeEventListener('mouseleave', handleDocumentMouseLeave);
  });
  attachedDocuments = [];
  clearNow();
  currentSettings = null;
}
