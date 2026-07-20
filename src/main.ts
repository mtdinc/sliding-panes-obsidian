import { Platform, Plugin, WorkspaceLeaf } from 'obsidian';
import { SlidingPanesSettings, SlidingPanesSettingTab, SlidingPanesCommands } from './settings';
import { getRootTabGroups, isStacked, setStacked, leafEl, requestLayoutRecompute, TabGroupLike } from './adapter';
import * as styleManager from './style-manager';
import * as widthManager from './width-manager';

// How long to wait after the last resize event before recalculating widths.
const RESIZE_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// main.ts is a thin lifecycle shell. It wires settings + commands, applies our
// styles, stacks the root tab groups, and forwards workspace events to the
// three owners: style-manager (classes/style), width-manager (inline widths),
// and adapter (private-API access). It contains no layout math itself.
// ---------------------------------------------------------------------------
export default class SlidingPanesPlugin extends Plugin {
  settings: SlidingPanesSettings;

  // Groups we've already auto-stacked. Tracked so we never re-stack a group the
  // user has manually un-stacked. A WeakSet lets closed groups be GC'd.
  private seenGroups = new WeakSet<TabGroupLike>();

  // We warn at most once if this Obsidian version can't be driven to stack.
  private warnedNoSetStacked = false;

  // Registered once, then left in place for the plugin's lifetime; the handlers
  // themselves no-op while disabled.
  private eventsRegistered = false;

  // Pending debounced resize recalc (window-typed so it's a number, not a Node timer).
  private resizeTimer: number | null = null;

  onload = async () => {
    this.settings = Object.assign(new SlidingPanesSettings(), await this.loadData());

    this.addSettingTab(new SlidingPanesSettingTab(this.app, this));
    new SlidingPanesCommands(this).addCommands();

    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.disabled) {
        this.enable();
      }
    });
  };

  onunload = () => {
    // disable() leaves nothing behind; safe even if we never enabled.
    this.disable();
  };

  // Turn the plugin on: apply styles, stack the root groups, size the panes,
  // and start listening for workspace changes.
  enable = () => {
    // Enabling means "stack my groups": forget which groups we've seen so even
    // ones manually un-stacked while the plugin was off get stacked again.
    // Manual un-stacks are only respected while the plugin stays enabled.
    this.seenGroups = new WeakSet<TabGroupLike>();

    styleManager.apply(this.app, this.settings);
    this.stackAllGroups();
    widthManager.recalcWidths(this.app, this.settings);
    this.registerEventHandlers();
    this.nudgeNativeLayout();
  };

  // Turn the plugin off: strip our styles and inline widths. We intentionally
  // do NOT un-stack groups — the user's tabs are left exactly as they are.
  disable = () => {
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    styleManager.remove(this.app);
    widthManager.clearWidths(this.app);
    // We blanked our inline min/max widths above; have Obsidian recompute its
    // own so panes don't sit uncapped until the next natural layout pass.
    this.nudgeNativeLayout();
  };

  // Re-apply everything after a settings change (called from the settings tab
  // and toggle commands). No-op while disabled.
  refresh = () => {
    if (this.settings.disabled) {
      return;
    }
    styleManager.apply(this.app, this.settings);
    widthManager.recalcWidths(this.app, this.settings);
    this.nudgeNativeLayout();
  };

  // Obsidian computes stacked-tab sticky offsets and inline min/max widths in
  // its own layout passes, which don't know about our CSS/width changes. Ask
  // each group to recompute and fire a synthetic resize per affected window.
  // Our own resize handler is debounced and idempotent, so this can't loop.
  private nudgeNativeLayout = () => {
    const groups = getRootTabGroups(this.app);
    const windows: Window[] = [];

    groups.forEach((group) => {
      requestLayoutRecompute(group);
      const win = group.containerEl.ownerDocument?.defaultView;
      if (win && !windows.includes(win)) {
        windows.push(win);
      }
    });

    windows.forEach((win) => {
      win.dispatchEvent(new Event('resize'));
    });
  };

  // Stack every root tab group we haven't seen before.
  private stackAllGroups = () => {
    // Native stacked tabs don't exist on phones (removed in Obsidian 1.5.8),
    // so there is nothing for us to drive there.
    if (Platform.isPhone) {
      return;
    }
    const groups = getRootTabGroups(this.app);
    groups.forEach((group) => {
      if (this.seenGroups.has(group)) {
        return; // already handled once; respect any manual un-stack since then
      }
      this.seenGroups.add(group);

      const stacked = setStacked(group, true);
      if (!stacked && !this.warnedNoSetStacked) {
        this.warnedNoSetStacked = true;
        console.warn(
          'Sliding Panes: this Obsidian version does not expose an internal ' +
          'setStacked() method, so tab groups cannot be auto-stacked. Stack ' +
          'them manually via the tab context menu ("Stack tab group").'
        );
      }
    });
  };

  // Register workspace event handlers exactly once.
  private registerEventHandlers = () => {
    if (this.eventsRegistered) {
      return;
    }
    this.eventsRegistered = true;

    this.registerEvent(this.app.workspace.on('layout-change', this.handleLayoutChange));
    this.registerEvent(this.app.workspace.on('resize', this.handleResize));
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange));
  };

  // Layout changed (tab opened/closed/moved, popout opened): stack any new
  // groups, re-apply styles to any new document, and resize panes.
  private handleLayoutChange = () => {
    if (this.settings.disabled) {
      return;
    }
    styleManager.apply(this.app, this.settings);
    this.stackAllGroups();
    widthManager.recalcWidths(this.app, this.settings);
  };

  // Window/pane resized: recalc widths, debounced so we don't thrash.
  private handleResize = () => {
    if (this.settings.disabled) {
      return;
    }
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      if (this.settings.disabled) {
        return;
      }
      widthManager.recalcWidths(this.app, this.settings);
    }, RESIZE_DEBOUNCE_MS);
  };

  // Active leaf changed: scroll it into view, but only when its group is one we
  // manage and is currently stacked.
  private handleActiveLeafChange = (leaf: WorkspaceLeaf | null) => {
    if (this.settings.disabled || !leaf) {
      return;
    }
    this.scrollActiveIntoView(leaf);
  };

  private scrollActiveIntoView = (leaf: WorkspaceLeaf) => {
    const element = leafEl(leaf);
    if (!element) {
      return;
    }

    const group = this.findManagedGroupForLeaf(element);
    if (!group || !isStacked(group)) {
      return;
    }

    const behavior: ScrollBehavior = this.settings.smoothAnimation ? 'smooth' : 'auto';
    element.scrollIntoView({ behavior: behavior, inline: 'nearest', block: 'nearest' });
  };

  // Find which managed root tab group contains a given leaf element, or null.
  private findManagedGroupForLeaf = (leafElement: HTMLElement): TabGroupLike | null => {
    const groups = getRootTabGroups(this.app);
    for (const group of groups) {
      if (group.containerEl.contains(leafElement)) {
        return group;
      }
    }
    return null;
  };
}
