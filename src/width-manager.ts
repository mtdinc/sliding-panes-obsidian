import { App, Platform } from 'obsidian';
import { SlidingPanesSettings } from './settings';
import { TabGroupLike, getRootTabGroups, getTabContainer, isStacked } from './adapter';

// ---------------------------------------------------------------------------
// width-manager.ts is the SOLE owner of the inline width styles we write onto
// stacked leaves. Obsidian writes its own inline min/max-width on leaves that
// fights the `--tab-stacked-pane-width` CSS variable, so the only reliable way
// to control pane width is to set inline width/minWidth/maxWidth ourselves.
// ---------------------------------------------------------------------------

// Auto-width never shrinks a pane below this, so at least one pane is readable
// even when many tabs are stacked.
const MIN_AUTO_PANE_WIDTH = 200;

// The desktop/mobile fixed width for a single pane. Exported so style-manager
// uses the same rule — this function is the ONE owner of the platform choice.
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

// In auto-width mode, a pane fills the group minus the space taken by the other
// panes' collapsed spines: clientWidth - (numTabHeaders - 1) * headerWidth.
function computeAutoWidth(group: TabGroupLike, tabContainer: HTMLElement, headerWidth: number): number {
  const tabHeaders = tabContainer.querySelectorAll('.workspace-tab-header');
  const numTabHeaders = tabHeaders.length;

  const numOtherSpines = Math.max(numTabHeaders - 1, 0);
  const spinesWidth = numOtherSpines * headerWidth;

  const availableWidth = group.containerEl.clientWidth - spinesWidth;
  return Math.max(MIN_AUTO_PANE_WIDTH, availableWidth);
}

// The target width (px) for panes in one stacked group.
function computeTargetWidth(group: TabGroupLike, tabContainer: HTMLElement, settings: SlidingPanesSettings): number {
  if (settings.leafAutoWidth) {
    return computeAutoWidth(group, tabContainer, settings.headerWidth);
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
