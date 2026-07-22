import { App, Platform, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';

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
}

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

export class SlidingPanesSettingTab extends PluginSettingTab {

  plugin: SlidingPanesPlugin;
  constructor(app: App, plugin: SlidingPanesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
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

    new Setting(containerEl)
      .setName('Smooth Animation')
      .setDesc('Whether pane movements (scrolling into view, peek grow/shrink) animate smoothly (on) or happen instantly (off)')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.smoothAnimation)
        .onChange((value) => {
          this.plugin.settings.smoothAnimation = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Leaf Auto Width')
      .setDesc('If on, panes share the screen equally (1 pane full width, 2 split in half, and so on) and never shrink below the width setting — beyond that they stack. If off, every pane is exactly the width setting.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.leafAutoWidth)
        .onChange((value) => {
          this.plugin.settings.leafAutoWidth = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Leaf Width on Desktop')
      .setDesc('Pane width: the minimum a pane shrinks to when auto width is on, or the exact pane width when it is off')
      .addText(text => text.setPlaceholder('Example: 550')
        .setValue((this.plugin.settings.leafDesktopWidth || '') + '')
        .onChange((value) => {
          this.plugin.settings.leafDesktopWidth = parseIntOr(value, 550);
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Leaf Width on Mobile')
      .setDesc('Pane width on mobile: the minimum a pane shrinks to when auto width is on, or the exact pane width when it is off')
      .addText(text => text.setPlaceholder('Example: 350')
        .setValue((this.plugin.settings.leafMobileWidth || '') + '')
        .onChange((value) => {
          this.plugin.settings.leafMobileWidth = parseIntOr(value, 350);
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName("Toggle rotated headers")
      .setDesc("When on, the note title is shown on each collapsed spine. When off, the spine stays but its title and icon are hidden.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.rotateHeaders)
        .onChange((value) => {
          this.plugin.settings.rotateHeaders = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName("Swap rotated header direction")
      .setDesc("Flips the direction the spine title text reads")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.headerAlt)
        .onChange((value) => {
          this.plugin.settings.headerAlt = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

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
        this.plugin.saveData(this.plugin.settings);
        this.plugin.refresh();
      })});

    new Setting(containerEl)
      .setName("Toggle stacking")
      .setDesc("When on, panes stack against the edges (native stacked tabs). When off, panes slide off-screen (classic mode).")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.stackingEnabled)
        .onChange((value) => {
          this.plugin.settings.stackingEnabled = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Hover Peek')
      .setDesc('When on, hovering a collapsed pane\'s spine (or a revealed content strip) briefly lifts that full pane above the stack (stacking mode only)')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.hoverPeek)
        .onChange((value) => {
          this.plugin.settings.hoverPeek = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Edge Reveal')
      .setDesc('When on, the nearest buried pane on the left always shows a strip of its content next to the spines, so you can see what\'s there without hovering (stacking mode only)')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.edgeReveal)
        .onChange((value) => {
          this.plugin.settings.edgeReveal = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Edge Reveal Width')
      .setDesc('How wide the revealed content strip is, in pixels')
      .addText(text => text.setPlaceholder('Example: 140')
        .setValue((this.plugin.settings.edgeRevealWidth || '') + '')
        .onChange((value) => {
          this.plugin.settings.edgeRevealWidth = parseIntOr(value, 140);
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Pin Buttons')
      .setDesc('When on, each spine shows a pin button (on hover, at the bottom). Pinning keeps that pane\'s left half visible above the stack whenever it is buried')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.pinButtons)
        .onChange((value) => {
          this.plugin.settings.pinButtons = value;
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));

    new Setting(containerEl)
      .setName('Spine Width')
      .setDesc('The width of the rotated header (or gap) for stacking')
      .addText(text => text.setPlaceholder('Example: 32')
        .setValue((this.plugin.settings.headerWidth || '') + '')
        .onChange((value) => {
          this.plugin.settings.headerWidth = parseIntOr(value, 32);
          this.plugin.saveData(this.plugin.settings);
          this.plugin.refresh();
        }));
  }
}

export class SlidingPanesCommands {
  plugin: SlidingPanesPlugin;
  constructor(plugin: SlidingPanesPlugin) {
    this.plugin = plugin;
  }

  addToggleSettingCommand(id:string, name:string, settingName:string) {
    this.plugin.addCommand({
      id: id,
      name: name,
      callback: () => {
        // switch the setting, save and refresh
        //@ts-ignore
        this.plugin.settings[settingName] = !this.plugin.settings[settingName];
        this.plugin.saveData(this.plugin.settings);
        this.plugin.refresh();
      }
    });
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
