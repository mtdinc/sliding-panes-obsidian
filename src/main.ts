import { Platform, Plugin, WorkspaceLeaf } from 'obsidian';
import { SlidingPanesSettings, SlidingPanesSettingTab, SlidingPanesCommands, sanitizeSettings } from './settings';
import { getRootTabGroups, leafEl, setStacked, requestLayoutRecompute, TabGroupLike } from './adapter';
import * as styleManager from './style-manager';
import * as widthManager from './width-manager';
import * as scrollManager from './scroll-manager';
import * as peekManager from './peek-manager';

// How long to wait after the last resize event before recalculating widths.
const RESIZE_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// main.ts is a thin lifecycle shell. It wires settings + commands, applies our
// styles, stacks the root tab groups, and forwards workspace events to the
// four owners: style-manager (classes/style), width-manager (inline widths),
// scroll-manager (active-pane scrolling), and adapter (private-API access).
// It contains no layout math itself.
// ---------------------------------------------------------------------------
export default class SlidingPanesPlugin extends Plugin {
  settings: SlidingPanesSettings;

  // Groups we've already auto-stacked. Tracked so we never re-stack a group the
  // user has manually un-stacked. A WeakSet lets closed groups be GC'd.
  private seenGroups = new WeakSet<TabGroupLike>();

  // We warn at most once if this Obsidian version can't be driven to stack.
  private warnedNoSetStacked = false;

  // Pending debounced resize recalc (window-typed so it's a number, not a Node timer).
  private resizeTimer: number | null = null;

  onload = async () => {
    this.settings = Object.assign(new SlidingPanesSettings(), await this.loadData());
    sanitizeSettings(this.settings);

    this.addSettingTab(new SlidingPanesSettingTab(this.app, this));
    new SlidingPanesCommands(this).addCommands();

    // Registered once for the plugin's lifetime; the handlers themselves
    // no-op while disabled.
    this.registerEvent(this.app.workspace.on('layout-change', this.handleLayoutChange));
    this.registerEvent(this.app.workspace.on('resize', this.handleResize));
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange));

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
    peekManager.attach(this.app, this.settings);
    this.nudgeNativeLayout();
  };

  // Turn the plugin off: strip our styles and inline widths. We intentionally
  // do NOT un-stack groups — the user's tabs are left exactly as they are.
  disable = () => {
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    peekManager.detach();
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
    // Drop any live peek before re-attaching: a toggle that turns hoverPeek or
    // stacking off mid-peek would otherwise leave the lifted pane stuck (the
    // handler's own guards stop it from ever reaching its hide path).
    peekManager.clearNow();
    peekManager.attach(this.app, this.settings);
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

  // Layout changed (tab opened/closed/moved, popout opened): stack any new
  // groups, re-apply styles to any new document, and resize panes.
  private handleLayoutChange = () => {
    if (this.settings.disabled) {
      return;
    }
    styleManager.apply(this.app, this.settings);
    this.stackAllGroups();
    widthManager.recalcWidths(this.app, this.settings);
    // A layout change can detach the elements a peek/landing sits on; drop
    // only those (unrelated churn — sidebar toggles, a deferred view loading —
    // must not kill a live lift). Also re-attach listeners so newly opened
    // popout windows are covered too.
    peekManager.clearIfDetached();
    peekManager.attach(this.app, this.settings);
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
      // New widths can change which panes are buried; re-check the edge
      // reveal strip and pin engagement.
      peekManager.reevaluate();
    }, RESIZE_DEBOUNCE_MS);
  };

  // Active leaf changed: scroll it into view. scroll-manager handles the
  // "is this a managed stacked group" check and the deferred timing.
  private handleActiveLeafChange = (leaf: WorkspaceLeaf | null) => {
    if (this.settings.disabled || !leaf) {
      return;
    }
    // peek-manager drops any hover peek and, if the newly active pane is still
    // buried, keeps it lifted until the scroll below uncovers it — otherwise
    // the clicked pane is invisible for the whole scroll animation.
    peekManager.handleActiveLeafChange(leafEl(leaf));
    scrollManager.scrollLeafIntoView(this.app, this.settings, leaf);
  };
}
