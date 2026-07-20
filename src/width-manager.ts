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

// In auto-width mode, panes share the group's width equally: each of the N
// panes gets clientWidth / N minus its own spine. One pane fills the screen,
// two split it in half, three in thirds — until the divided width would drop
// below the fixed width setting, which acts as the floor. At the floor, panes
// overflow the group and the stacking/sliding behavior takes over.
function computeAutoWidth(group: TabGroupLike, tabContainer: HTMLElement, settings: SlidingPanesSettings): number {
  const tabHeaders = tabContainer.querySelectorAll('.workspace-tab-header');
  const numPanes = Math.max(tabHeaders.length, 1);

  const widthPerPane = group.containerEl.clientWidth / numPanes;
  const dividedWidth = Math.floor(widthPerPane - settings.headerWidth);

  const minimumWidth = getFixedWidth(settings);
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
