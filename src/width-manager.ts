import { App, Platform } from 'obsidian';
import { SlidingPanesSettings } from './settings';
import { TabGroupLike, getLeafElements, getRootTabGroups, getTabContainer, isStacked } from './adapter';

// ---------------------------------------------------------------------------
// width-manager.ts is the SOLE owner of the inline width styles we write onto
// stacked leaves. Obsidian writes its own inline min/max-width on leaves that
// fights the `--tab-stacked-pane-width` CSS variable, so the only reliable way
// to control pane width is to set inline width/minWidth/maxWidth ourselves.
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

// The auto-width geometry for one stacked group: how wide each pane is, and
// how wide the edge-reveal strip's dedicated lane is (0 when it gets none).
// Both numbers come from the same arithmetic, so they live in one function —
// scroll-manager parks the active pane past the lane, and if it computed the
// lane independently the two could disagree and panes would land misaligned.
interface StackedAutoLayout {
  paneWidth: number;
  revealSlotWidth: number;
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

// In auto-width mode, panes tile the screen exactly; see
// computeStackedAutoLayout for the stacking arithmetic.
function computeAutoWidth(group: TabGroupLike, tabContainer: HTMLElement, settings: SlidingPanesSettings): number {
  const tabHeaders = tabContainer.querySelectorAll('.workspace-tab-header');
  const numPanes = Math.max(tabHeaders.length, 1);
  const groupWidth = group.containerEl.clientWidth;
  const minimumWidth = getFixedWidth(settings);
  const spineWidth = settings.headerWidth;

  // The spine accounting differs by mode. In both branches the "visible pane"
  // count is clamped: at least one pane is always visible, and we never spread
  // wider than the number of panes that actually exist.

  if (settings.stackingEnabled) {
    return computeStackedAutoLayout(group, tabContainer, settings).paneWidth;
  }

  // Stacking OFF (slide-off) scrolls spines with their panes, so only the
  // spines of the panes actually on screen take up room — and never more
  // spines than panes that exist, or panes would come out too narrow and
  // leave a gap on wide screens.
  const panesThatFit = Math.floor(groupWidth / (minimumWidth + spineWidth));
  const visiblePanes = Math.min(Math.max(panesThatFit, 1), numPanes);
  const contentWidth = groupWidth - visiblePanes * spineWidth;
  const dividedWidth = Math.floor(contentWidth / visiblePanes);
  return Math.max(dividedWidth, minimumWidth);
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
