import { App, WorkspaceLeaf } from 'obsidian';

// ---------------------------------------------------------------------------
// adapter.ts is the SOLE owner of Obsidian's private / untyped internals.
// Everything fragile about "what does the native stacked-tabs API look like"
// lives here, behind a small typed surface. If Obsidian renames or moves an
// internal, this is the only file that should need to change.
// ---------------------------------------------------------------------------

// A deliberately thin view of Obsidian's internal WorkspaceTabs group.
// We only ever touch containerEl and children; everything else stays unknown
// on purpose so we don't grow a dependency on internals we don't need.
export interface TabGroupLike {
  containerEl: HTMLElement;
  children: unknown[];
}

// Recursively walk a workspace node, collecting every descendant that is a
// tab group (its containerEl carries the `workspace-tabs` class).
function collectTabGroups(node: any, collected: TabGroupLike[]): void {
  if (!node) {
    return;
  }

  const containerEl = node.containerEl as HTMLElement | undefined;
  const isTabGroup = containerEl && containerEl.hasClass('workspace-tabs');
  if (isTabGroup) {
    collected.push(node as TabGroupLike);
  }

  const children = node.children as any[] | undefined;
  if (Array.isArray(children)) {
    children.forEach((child) => collectTabGroups(child, collected));
  }
}

// Enumerate every root tab group: the main window (rootSplit) plus any popout
// windows (floatingSplit). Popout groups live in a separate document, which is
// why style-manager reads containerEl.ownerDocument from these.
export function getRootTabGroups(app: App): TabGroupLike[] {
  const groups: TabGroupLike[] = [];

  const rootSplit = (app.workspace as any).rootSplit;
  collectTabGroups(rootSplit, groups);

  const floatingSplit = (app.workspace as any).floatingSplit;
  collectTabGroups(floatingSplit, groups);

  return groups;
}

// Every document the workspace spans: the main window, plus any popout
// windows (reached via their tab groups' ownerDocument). Popouts are separate
// documents, which is why anything styling or listening on "the DOM" must
// enumerate documents through this instead of assuming the global one.
export function collectDocuments(app: App): Document[] {
  const documents: Document[] = [document];

  const groups = getRootTabGroups(app);
  groups.forEach((group) => {
    const groupDocument = group.containerEl.ownerDocument;
    if (groupDocument && !documents.includes(groupDocument)) {
      documents.push(groupDocument);
    }
  });

  return documents;
}

// Is this tab group currently in native stacked mode?
export function isStacked(group: TabGroupLike): boolean {
  return group.containerEl.hasClass('mod-stacked');
}

// Put a tab group into (on=true) or out of (on=false) native stacked mode.
// Returns true if the group is in the desired state afterwards, false if the
// internal method is unavailable on this Obsidian version. The caller is
// responsible for logging a single warning when false is returned; we do NOT
// fall back to the focus-stealing native command here.
export function setStacked(group: TabGroupLike, on: boolean): boolean {
  if (isStacked(group) === on) {
    return true;
  }

  const groupWithMethod = group as any;
  const hasSetStacked = typeof groupWithMethod.setStacked === 'function';
  if (hasSetStacked) {
    groupWithMethod.setStacked(on);
    // Verify the call actually took effect: on phones Obsidian removed stacked
    // tabs entirely and may coerce the state right back, and a silent "success"
    // there would suppress the caller's warning.
    return isStacked(group) === on;
  }

  return false;
}

// Ask Obsidian to recompute a group's child dimensions (sticky spine offsets,
// inline min/max widths). Internal method — probe and skip if absent. Used
// after we change the spine width or strip our inline widths, because Obsidian
// only recomputes these on its own resize/layout passes.
export function requestLayoutRecompute(group: TabGroupLike): void {
  const groupWithMethod = group as any;
  if (typeof groupWithMethod.recomputeChildrenDimensions === 'function') {
    groupWithMethod.recomputeChildrenDimensions();
  }
}

// The DOM element for a leaf (untyped on WorkspaceLeaf), or null if absent.
export function leafEl(leaf: unknown): HTMLElement | null {
  return (leaf as any).containerEl ?? null;
}

// The WorkspaceLeaf that owns this leaf element, or null — the reverse of
// leafEl(). iterateAllLeaves covers the main window, popouts, and sidebars.
export function leafForElement(app: App, leafElement: HTMLElement): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (!found && leafEl(leaf) === leafElement) {
      found = leaf;
    }
  });
  return found;
}

// Popout windows are separate JavaScript realms, so `instanceof HTMLElement`
// against THIS window's constructor wrongly fails for their elements. Every
// element check in the plugin duck-types on `.style` through this one
// function instead of using instanceof anywhere.
export function isStylableElement(node: unknown): node is HTMLElement {
  const element = node as HTMLElement | null;
  return !!element && element.style !== undefined;
}

// The scrollable `.workspace-tab-container` element inside a tab group, or
// null.
export function getTabContainer(group: TabGroupLike): HTMLElement | null {
  const tabContainer = group.containerEl.querySelector('.workspace-tab-container');
  if (isStylableElement(tabContainer)) {
    return tabContainer;
  }
  return null;
}

// The direct `.workspace-leaf` children of a tab container, in DOM order. In
// stacked mode the container interleaves header and leaf elements; callers
// that need "just the panes" go through this.
export function getLeafElements(tabContainer: HTMLElement): HTMLElement[] {
  const nodeList = tabContainer.querySelectorAll(':scope > .workspace-leaf');
  const leafElements: HTMLElement[] = [];
  nodeList.forEach((node) => {
    if (isStylableElement(node)) {
      leafElements.push(node);
    }
  });
  return leafElements;
}

// The next `.workspace-leaf` sibling after this element, or null — skips the
// interleaved header elements.
export function nextLeafSibling(element: HTMLElement): HTMLElement | null {
  let next = element.nextElementSibling;
  while (next && !next.classList.contains('workspace-leaf')) {
    next = next.nextElementSibling;
  }
  return next as HTMLElement | null;
}

// The pane belonging to a spine: in stacked mode the container interleaves
// header and leaf elements, so the pane is the spine's next element sibling.
export function leafForHeader(header: HTMLElement): HTMLElement | null {
  const sibling = header.nextElementSibling as HTMLElement | null;
  if (sibling && sibling.classList.contains('workspace-leaf')) {
    return sibling;
  }
  return null;
}

// Is this element inside a stacked tab group in a root workspace area (main
// window or popout), not a sidebar? Class-based so it is cheap enough for hot
// paths (hover handlers); groupForElement below answers the same question
// when the caller needs the group object itself.
export function isManagedElement(element: HTMLElement): boolean {
  const inStackedGroup = element.closest('.workspace-tabs.mod-stacked') !== null;
  const inRootArea = element.closest('.mod-root') !== null;
  return inStackedGroup && inRootArea;
}

// Which root tab group contains this element, or null.
export function groupForElement(app: App, element: HTMLElement): TabGroupLike | null {
  const groups = getRootTabGroups(app);
  for (const group of groups) {
    if (group.containerEl.contains(element)) {
      return group;
    }
  }
  return null;
}
