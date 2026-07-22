import { App, Platform } from 'obsidian';
import { SlidingPanesSettings } from './settings';
import { TabGroupLike, getRootTabGroups, getTabContainer, isStacked } from './adapter';

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

// Popout windows are separate JavaScript realms, so `instanceof HTMLElement`
// against THIS window's constructor wrongly fails for their elements. We
// duck-type on `.style` instead of using instanceof anywhere in this file.
// (adapter.getTabContainer applies the same rule for the container itself.)
function isStylableElement(node: unknown): node is HTMLElement {
  const element = node as HTMLElement | null;
  return !!element && element.style !== undefined;
}

// The direct `.workspace-leaf` children of a tab container.
function getLeafElements(tabContainer: HTMLElement): HTMLElement[] {
  const nodeList = tabContainer.querySelectorAll(':scope > .workspace-leaf');
  const leafElements: HTMLElement[] = [];
  nodeList.forEach((node) => {
    if (isStylableElement(node)) {
      leafElements.push(node);
    }
  });
  return leafElements;
}

// In auto-width mode, the panes that fit on screen tile it exactly: work out
// how many panes can be fully visible without shrinking below the fixed-width
// floor, then split the available space evenly among exactly that many. When
// every pane fits this is plain equal distribution (1 pane full width, 2 split
// in half, ...); once panes overflow into stacking, the visible panes still
// sit flush against the spines instead of leaving an arbitrary sliver or gap.
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
    // Stacking ON pins ALL spines on screen at all times, so every spine
    // subtracts from the group width before panes divide what's left.
    const contentWidth = groupWidth - numPanes * spineWidth;
    const panesThatFit = Math.floor(contentWidth / minimumWidth);
    const visiblePanes = Math.min(Math.max(panesThatFit, 1), numPanes);
    const dividedWidth = Math.floor(contentWidth / visiblePanes);
    return Math.max(dividedWidth, minimumWidth);
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
