import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';
import * as peekManager from './peek-manager';
import * as scrollManager from './scroll-manager';
import * as widthManager from './width-manager';

export type Orientation = "sideway" | "mixed" | "upright"

// Minimal typed view of the plugin, so this file doesn't import main.ts
// (which would create a circular dependency).
declare class SlidingPanesPlugin extends Plugin {
  settings: SlidingPanesSettings;
  disable(): void;
  enable(): void;
  refresh(): void;
}

// Setting keys are preserved EXACTLY from v3 (including the misspelled
// `orienation`) so existing users' saved data.json keeps loading unchanged.
export class SlidingPanesSettings {
  headerWidth: number = 32;
  leafDesktopWidth: number = 550;
  leafMobileWidth: number = 350;
  leafAutoWidth: boolean = true;
  disabled: boolean = false;
  rotateHeaders: boolean = true;
  headerAlt: boolean = false;
  orienation: Orientation = "mixed";
  stackingEnabled: boolean = true;
  smoothAnimation: boolean = true;
  hoverPeek: boolean = true;
  pinButtons: boolean = true;
  edgeReveal: boolean = true;
  edgeRevealWidth: number = 140;
  doubleClickFocus: boolean = true;
}

// NB: the visible pane count (the dial) is deliberately NOT a setting — it is
// stored per device in localStorage by width-manager, because data.json syncs
// with the vault and a desktop and a laptop want different counts.

// The settings keys that hold booleans / numbers, derived from the class
// above so the helpers below can only be pointed at a key of the right type
// — a typo'd or wrongly-typed key becomes a compile error, not a silent bug.
type BooleanSettingKey = {
  [K in keyof SlidingPanesSettings]: SlidingPanesSettings[K] extends boolean ? K : never;
}[keyof SlidingPanesSettings];
type NumberSettingKey = {
  [K in keyof SlidingPanesSettings]: SlidingPanesSettings[K] extends number ? K : never;
}[keyof SlidingPanesSettings];

// Parse a numeric text field; fall back to `fallback` while the input isn't
// a real number. These handlers fire per keystroke (including on a freshly
// emptied field), and a NaN stored here flows into width/clip math AND gets
// persisted (JSON turns NaN into null, which then survives restarts).
function parseIntOr(value: string, fallback: number): number {
  const parsed = parseInt(value.trim());
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return fallback;
}

// The reveal strip's usable range. Below the minimum the strip is too narrow
// to read anything from; above the maximum it stops being a strip at all — the
// clip no longer hides any of the pane, so a full unclipped pane sits at
// z-index 8 painting over every pane to its right.
//
// The minimum is exported because it is not only a settings clamp: peek-manager
// applies the SAME floor to the strip it actually draws (the room available can
// be narrower than the setting asked for), and two copies of that number could
// drift apart.
export const MIN_EDGE_REVEAL_WIDTH = 40;
const MAX_EDGE_REVEAL_WIDTH = 600;

// Heal any non-finite numeric setting back to its default, then clamp the ones
// that also have a usable RANGE. Older versions could persist NaN (JSON stores
// it as null, which Object.assign then copies over the default). Numeric keys
// are derived from the defaults instance, so a new numeric setting is covered
// by the finite check automatically — no key list to maintain.
export function sanitizeSettings(settings: SlidingPanesSettings): void {
  const defaults = new SlidingPanesSettings();
  const allKeys = Object.keys(defaults) as (keyof SlidingPanesSettings)[];
  allKeys.forEach((key) => {
    const defaultValue = defaults[key];
    if (typeof defaultValue === 'number' && !Number.isFinite(settings[key])) {
      (settings[key] as number) = defaultValue;
    }
  });

  const clampedRevealWidth = Math.min(
    Math.max(settings.edgeRevealWidth, MIN_EDGE_REVEAL_WIDTH),
    MAX_EDGE_REVEAL_WIDTH
  );
  settings.edgeRevealWidth = clampedRevealWidth;
}

// Wait this long after the last keystroke in a numeric field before saving
// and refreshing — refresh() re-applies styles and widths across every
// window, far too heavy to run three times while "550" is being typed.
const NUMERIC_SAVE_DEBOUNCE_MS = 300;

export class SlidingPanesSettingTab extends PluginSettingTab {

  plugin: SlidingPanesPlugin;
  constructor(app: App, plugin: SlidingPanesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Save the settings and re-apply them. Shared by every control below.
  // Sanitizing here as well as at load is what keeps an out-of-range value
  // typed into a field from taking effect for the rest of the session.
  private saveAndRefresh(): void {
    sanitizeSettings(this.plugin.settings);
    this.plugin.saveData(this.plugin.settings);
    this.plugin.refresh();
  }

  // A standard on/off setting bound to one boolean settings key.
  private addToggleSetting(name: string, desc: string, key: BooleanSettingKey): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle(toggle => toggle.setValue(this.plugin.settings[key])
        .onChange((value) => {
          this.plugin.settings[key] = value;
          this.saveAndRefresh();
        }));
  }

  // A numeric text setting bound to one numeric settings key. The default —
  // used as the placeholder and as the fallback for unparseable input — comes
  // from the settings class itself, so the two can never drift. The value is
  // applied immediately; saving and refreshing is debounced because onChange
  // fires per keystroke.
  private addNumericSetting(name: string, desc: string, key: NumberSettingKey): void {
    const defaultValue = new SlidingPanesSettings()[key];
    let saveTimer: number | null = null;
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText(text => text.setPlaceholder('Example: ' + defaultValue)
        .setValue((this.plugin.settings[key] || '') + '')
        .onChange((value) => {
          this.plugin.settings[key] = parseIntOr(value, defaultValue);
          if (saveTimer !== null) {
            window.clearTimeout(saveTimer);
          }
          saveTimer = window.setTimeout(() => {
            saveTimer = null;
            this.saveAndRefresh(); // may clamp the value into its usable range
            // Show what is actually in effect. Without this the field keeps
            // displaying an out-of-range number that nothing is using, and
            // reopening the tab would silently change what the user sees.
            const storedValue = String(this.plugin.settings[key]);
            if (text.getValue() !== storedValue) {
              text.setValue(storedValue);
            }
          }, NUMERIC_SAVE_DEBOUNCE_MS);
        }));
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    // Native stacked tabs don't exist on phones, so the whole plugin no-ops
    // there; say so instead of showing settings that silently do nothing.
    if (Platform.isPhone) {
      containerEl.createEl('p', {
        text: 'Note: stacked tabs are not available on phones, so Sliding Panes has no effect here. These settings apply on desktop and tablet.',
      });
    }

    new Setting(containerEl)
      .setName("Toggle Sliding Panes")
      .setDesc("Turns sliding panes on or off globally. When on, all root tab groups are stacked.")
      .addToggle(toggle => toggle.setValue(!this.plugin.settings.disabled)
        .onChange((value) => {
          this.plugin.settings.disabled = !value;
          this.plugin.saveData(this.plugin.settings);
          if (this.plugin.settings.disabled) {
            this.plugin.disable();
          }
          else {
            this.plugin.enable();
          }
        }));

    this.addToggleSetting('Smooth Animation',
      'Whether pane movements (scrolling into view, peek grow/shrink) animate smoothly (on) or happen instantly (off)',
      'smoothAnimation');

    this.addToggleSetting('Leaf Auto Width',
      'If on, panes share the screen equally (1 pane full width, 2 split in half, and so on) and never shrink below the width setting — beyond that they stack. If off, every pane is exactly the width setting.',
      'leafAutoWidth');

    this.addNumericSetting('Leaf Width on Desktop',
      'Pane width: the minimum a pane shrinks to when auto width is on, or the exact pane width when it is off',
      'leafDesktopWidth');

    this.addNumericSetting('Leaf Width on Mobile',
      'Pane width on mobile: the minimum a pane shrinks to when auto width is on, or the exact pane width when it is off',
      'leafMobileWidth');

    this.addToggleSetting('Toggle rotated headers',
      'When on, the note title is shown on each collapsed spine. When off, the spine stays but its title and icon are hidden.',
      'rotateHeaders');

    this.addToggleSetting('Swap rotated header direction',
      'Flips the direction the spine title text reads',
      'headerAlt');

    new Setting(containerEl)
    .setName("Header text orientation")
    .setDesc("Select the header text orientation")
    .addDropdown((dropdown) => {
      dropdown.addOption("sideway", "Sideway")
      dropdown.addOption("mixed", "Mixed")
      dropdown.addOption("upright", "Upright")
      dropdown.setValue(this.plugin.settings.orienation)
      dropdown.onChange((value: Orientation) => {
        this.plugin.settings.orienation = value;
        this.saveAndRefresh();
      })});

    this.addToggleSetting('Toggle stacking',
      'When on, panes stack against the edges (native stacked tabs). When off, panes slide off-screen (classic mode).',
      'stackingEnabled');

    this.addToggleSetting('Hover Peek',
      'When on, hovering a collapsed pane\'s spine (or a revealed content strip) briefly lifts that full pane above the stack (stacking mode only)',
      'hoverPeek');

    this.addToggleSetting('Edge Reveal',
      'When on, the nearest buried pane on the left always shows a strip of its content next to the spines, so you can see what\'s there without hovering (stacking mode only)',
      'edgeReveal');

    this.addNumericSetting('Edge Reveal Width',
      'How wide the revealed content strip is, in pixels',
      'edgeRevealWidth');

    this.addToggleSetting('Pin Buttons',
      'When on, each spine shows a pin button (on hover, at the bottom). Pinning keeps that pane\'s left half visible above the stack whenever it is buried',
      'pinButtons');

    this.addToggleSetting('Double-click Spine for Focus',
      'When on, double-clicking any spine toggles focus mode, giving the active pane the full width (double-click again to restore). While focused, a single click on a spine switches which note fills the view',
      'doubleClickFocus');

    this.addNumericSetting('Spine Width',
      'The width of the rotated header (or gap) for stacking',
      'headerWidth');
  }
}

export class SlidingPanesCommands {
  plugin: SlidingPanesPlugin;
  constructor(plugin: SlidingPanesPlugin) {
    this.plugin = plugin;
  }

  addToggleSettingCommand(id: string, name: string, settingName: BooleanSettingKey) {
    this.plugin.addCommand({
      id: id,
      name: name,
      callback: () => {
        // switch the setting, save and refresh
        this.plugin.settings[settingName] = !this.plugin.settings[settingName];
        this.plugin.saveData(this.plugin.settings);
        this.plugin.refresh();
      }
    });
  }

  // Report and land one pane-count command. width-manager already decided what
  // to do, persisted it, and re-applied the widths; all that is left is telling
  // the user and making the new layout land somewhere sensible.
  private runPaneCountCommand(outcome: widthManager.PaneCountOutcome): void {
    new Notice(outcome.message);
    if (!outcome.changed) {
      return;
    }

    this.plugin.refresh();
    // refresh() re-applies styles, widths and peek state but never scrolls, and
    // changing the pane count can leave the pane the user is reading buried
    // behind the spines — so bring it back into view explicitly.
    const activeLeaf = this.plugin.app.workspace.getMostRecentLeaf();
    if (activeLeaf) {
      scrollManager.scrollLeafIntoView(this.plugin.app, this.plugin.settings, activeLeaf);
    }
  }

  // Move focus to the pane one position to the left (direction -1) or right (+1)
  // of the currently active pane, in root-leaf order.
  focusAdjacentLeaf(direction: number) {
    const workspace = this.plugin.app.workspace;

    const activeLeaf = workspace.getMostRecentLeaf();
    if (!activeLeaf) {
      return;
    }

    // Build the ordered list of panes in the same window area as the active
    // leaf (its root). Comparing roots keeps sidebar leaves out and makes the
    // commands work inside popout windows too, where iterateRootLeaves
    // (main window only) would come up empty.
    const activeRoot = activeLeaf.getRoot();
    const rootLeaves: WorkspaceLeaf[] = [];
    workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (leaf.getRoot() === activeRoot) {
        rootLeaves.push(leaf);
      }
    });

    const activeIndex = rootLeaves.indexOf(activeLeaf);
    if (activeIndex === -1) {
      return;
    }

    const targetIndex = activeIndex + direction;
    if (targetIndex < 0 || targetIndex >= rootLeaves.length) {
      return; // already at the edge
    }

    const targetLeaf = rootLeaves[targetIndex];
    workspace.setActiveLeaf(targetLeaf, { focus: true });
  }

  addCommands(): void {
    // add the toggle on/off command
    this.plugin.addCommand({
      id: 'toggle-sliding-panes',
      name: 'Toggle Sliding Panes',
      callback: () => {
        // switch the disabled setting and save
        this.plugin.settings.disabled = !this.plugin.settings.disabled;
        this.plugin.saveData(this.plugin.settings);

        // disable or enable as necessary
        this.plugin.settings.disabled ? this.plugin.disable() : this.plugin.enable();
      }
    });

    // add a command to toggle smooth animation
    this.addToggleSettingCommand('toggle-sliding-panes-smooth-animation', 'Toggle Smooth Animation', 'smoothAnimation');

    // add a command to toggle leaf auto width
    this.addToggleSettingCommand('toggle-sliding-panes-leaf-auto-width', 'Toggle Leaf Auto Width', 'leafAutoWidth');

    // add a command to toggle stacking
    this.addToggleSettingCommand('toggle-sliding-panes-stacking', 'Toggle Stacking', 'stackingEnabled');

    // add a command to toggle hover peek
    this.addToggleSettingCommand('toggle-sliding-panes-hover-peek', 'Toggle Hover Peek', 'hoverPeek');

    // add a command to toggle edge reveal
    this.addToggleSettingCommand('toggle-sliding-panes-edge-reveal', 'Toggle Edge Reveal', 'edgeReveal');

    // add a command to toggle pin buttons
    this.addToggleSettingCommand('toggle-sliding-panes-pin-buttons', 'Toggle Pin Buttons', 'pinButtons');

    // add a command to toggle rotated headers
    this.addToggleSettingCommand('toggle-sliding-panes-rotated-headers', 'Toggle Rotated Headers', 'rotateHeaders');

    // add a command to toggle swapped header direction
    this.addToggleSettingCommand('toggle-sliding-panes-header-alt', 'Swap rotated header direction', 'headerAlt');

    // pin/unpin the current pane: the spine pin button only appears on hover,
    // so touch screens and keyboard users need this path
    this.plugin.addCommand({
      id: 'toggle-pin-current-pane',
      name: 'Toggle pin on current pane',
      callback: () => {
        peekManager.togglePinForActiveLeaf(this.plugin.app, this.plugin.settings);
      }
    });

    // the visible-pane-count dial and focus mode. width-manager owns the count
    // (and remembers it per device); these commands only report the result.
    this.plugin.addCommand({
      id: 'increase-visible-panes',
      name: 'Show one more pane',
      callback: () => {
        this.runPaneCountCommand(widthManager.adjustPaneCount(this.plugin.app, this.plugin.settings, 1));
      }
    });

    this.plugin.addCommand({
      id: 'decrease-visible-panes',
      name: 'Show one fewer pane',
      callback: () => {
        this.runPaneCountCommand(widthManager.adjustPaneCount(this.plugin.app, this.plugin.settings, -1));
      }
    });

    this.plugin.addCommand({
      id: 'reset-visible-panes',
      name: 'Reset pane count to automatic',
      callback: () => {
        this.runPaneCountCommand(widthManager.resetPaneCount(this.plugin.app, this.plugin.settings));
      }
    });

    this.plugin.addCommand({
      id: 'toggle-focus-mode',
      name: 'Toggle focus mode (active pane full width)',
      callback: () => {
        this.runPaneCountCommand(widthManager.toggleFocusMode(this.plugin.app, this.plugin.settings));
      }
    });

    // move focus to the pane on the left
    this.plugin.addCommand({
      id: 'focus-left-pane',
      name: 'Focus Left Pane',
      callback: () => {
        this.focusAdjacentLeaf(-1);
      }
    });

    // move focus to the pane on the right
    this.plugin.addCommand({
      id: 'focus-right-pane',
      name: 'Focus Right Pane',
      callback: () => {
        this.focusAdjacentLeaf(1);
      }
    });
  }
}
