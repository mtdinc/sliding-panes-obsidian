import { App } from 'obsidian';
import { SlidingPanesSettings } from './settings';
import { TabGroupLike, getLeafElements, getTabContainer, groupForElement, isStacked, leafEl } from './adapter';
import { getRevealSlotWidth } from './width-manager';

// ---------------------------------------------------------------------------
// scroll-manager.ts is the SOLE owner of "bring the active pane into view".
//
// scrollIntoView() cannot do this job, for two reasons:
//  1. Geometry: with stacking on, the sticky spines of the OTHER tabs pin over
//     both edges of the scrollport. scrollIntoView knows nothing about them,
//     so `inline: 'nearest'` happily parks the pane underneath a spine.
//  2. Timing: active-leaf-change fires before Obsidian's layout pass and our
//     own width pass have run for a freshly created tab, so an immediate
//     scroll targets stale geometry.
// We fix (1) by computing the target scrollLeft ourselves from the spine
// geometry, and (2) by deferring the scroll by two animation frames.
// ---------------------------------------------------------------------------

// Scroll distances smaller than this are noise; skip them to avoid jitter.
const SCROLL_EPSILON_PX = 1;

// Monotonic id of the most recent scroll request, PER SCROLL CONTAINER. A
// deferred callback only runs if it is still the latest request for its own
// container, so rapid tab switches can't fire a stale scroll after a newer one
// was queued.
//
// Keyed per container rather than by one shared counter: with a single id, two
// requests issued in the same pass but aimed at DIFFERENT containers cancelled
// each other, and only the last one ever ran. That is wrong for any caller
// parking more than one group at a time — a split layout's sibling groups, or
// the main window and a popout — where every request targets a scrollport of
// its own and none of them supersedes another. A WeakMap lets a closed group's
// container (and its entry) be garbage collected.
const latestRequestIds = new WeakMap<HTMLElement, number>();

// Known limitation: the math below assumes LTR layout. RTL workspaces reverse
// the scroll axis (negative scrollLeft); v3 never handled that either.

// Compute and apply the scrollLeft that makes the pane fully visible between
// the pinned spines. Runs after the two-frame delay, so re-check that the
// elements are still in the document.
function applyScroll(group: TabGroupLike, container: HTMLElement, leafElement: HTMLElement, settings: SlidingPanesSettings): void {
  if (!container.isConnected || !leafElement.isConnected) {
    return;
  }

  const leafElements = getLeafElements(container);
  const leafIndex = leafElements.indexOf(leafElement);
  if (leafIndex === -1) {
    return;
  }
  const leafCount = leafElements.length;

  // Leaf position in the container's scroll (flow) coordinate space, built by
  // summing the widths of every earlier sibling. We must NOT derive this from
  // getBoundingClientRect() positions: in stacking mode the panes themselves
  // are position:sticky, so a pinned pane's rect reports where it is STUCK,
  // not where it lives in the flow — which wrongly reads as "already visible"
  // for a pane that is actually buried under the panes stacked after it.
  // Sticky shifts positions, never widths, so summing widths stays correct.
  let leafLeft = 0;
  const siblings = Array.from(container.children);
  for (const sibling of siblings) {
    if (sibling === leafElement) {
      break;
    }
    leafLeft += (sibling as HTMLElement).getBoundingClientRect().width;
  }
  const leafRight = leafLeft + leafElement.getBoundingClientRect().width;

  // How much of each scrollport edge is covered by pinned spines.
  // Stacking ON: the spines of every earlier tab plus the pane's own spine pin
  // to the left edge; the spines of every later tab pin to the right edge.
  // Stacking OFF (slide-off mode): spines scroll with the content, so nothing
  // covers the edges — but we still reserve room on the left for the pane's
  // own in-flow spine so it stays visible for context.
  const headerWidth = settings.headerWidth;
  let leftInset: number;
  let rightInset: number;
  if (settings.stackingEnabled) {
    leftInset = (leafIndex + 1) * headerWidth;
    rightInset = (leafCount - 1 - leafIndex) * headerWidth;
    // When a pane is buried to our left, peek-manager shows its edge-reveal
    // strip right after the spines; park the active pane past the strip's
    // dedicated lane so the two don't overlap. width-manager owns the lane
    // decision (it can shrink to the spare space, or to 0) — asking it keeps
    // scroll parking and pane widths in agreement.
    if (leafIndex > 0) {
      leftInset += getRevealSlotWidth(group, settings);
    }
  } else {
    leftInset = headerWidth;
    rightInset = 0;
  }

  // The scrollLeft range in which the pane is fully visible:
  // at scrollForRightEdge the pane's right edge clears the right spines,
  // at scrollForLeftEdge the pane's left edge clears the left spines.
  const viewportWidth = container.clientWidth;
  const scrollForRightEdge = leafRight - (viewportWidth - rightInset);
  const scrollForLeftEdge = leafLeft - leftInset;

  let targetScroll = container.scrollLeft;
  if (targetScroll < scrollForRightEdge) {
    targetScroll = scrollForRightEdge;
  }
  // Applied second so it wins when the pane is wider than the visible span:
  // showing the pane's left edge beats showing its right edge.
  if (targetScroll > scrollForLeftEdge) {
    targetScroll = scrollForLeftEdge;
  }

  const maxScrollLeft = container.scrollWidth - viewportWidth;
  targetScroll = Math.max(0, Math.min(targetScroll, maxScrollLeft));

  if (Math.abs(targetScroll - container.scrollLeft) < SCROLL_EPSILON_PX) {
    return;
  }

  const behavior: ScrollBehavior = settings.smoothAnimation ? 'smooth' : 'auto';
  container.scrollTo({ left: targetScroll, behavior: behavior });
}

// Scroll the given leaf's pane into view, if it belongs to a managed stacked
// group. Safe to call for any leaf; non-managed leaves are ignored.
export function scrollLeafIntoView(app: App, settings: SlidingPanesSettings, leaf: unknown): void {
  const leafElement = leafEl(leaf);
  if (!leafElement) {
    return;
  }

  const group = groupForElement(app, leafElement);
  if (!group || !isStacked(group)) {
    return;
  }

  const container = getTabContainer(group);
  if (!container || !container.contains(leafElement)) {
    return;
  }

  // Two frames: the first lets Obsidian's synchronous layout work (and our
  // layout-change width pass) finish; the second lets the browser lay those
  // changes out so the rects we measure are final. Use the leaf's own window —
  // popouts have their own frame clock.
  const previousRequestId = latestRequestIds.get(container) ?? 0;
  const requestId = previousRequestId + 1;
  latestRequestIds.set(container, requestId);
  const win = container.ownerDocument.defaultView ?? window;
  win.requestAnimationFrame(() => {
    win.requestAnimationFrame(() => {
      if (requestId !== latestRequestIds.get(container)) {
        return; // a newer scroll request for this container superseded this one
      }
      if (settings.disabled) {
        return; // plugin was turned off while this scroll was queued
      }
      applyScroll(group, container, leafElement, settings);
    });
  });
}
