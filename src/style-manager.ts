import { App } from 'obsidian';
import { SlidingPanesSettings, Orientation } from './settings';
import { getRootTabGroups } from './adapter';
import { getFixedWidth } from './width-manager';

// ---------------------------------------------------------------------------
// style-manager.ts is the SOLE owner of the plugin's body classes and its one
// injected <style> element. styles.scss holds the static rules; this file only
// toggles the classes those rules key off, and injects the couple of CSS
// variables that depend on numeric settings.
//
// The body-class NAMES are kept identical to v3 on purpose, so existing user
// CSS snippets that target them keep working.
// ---------------------------------------------------------------------------

const STYLE_ELEMENT_ID = 'plugin-sliding-panes';

// Every class this file may add, listed so remove() can strip them all without
// needing to know the current settings.
const ALL_BODY_CLASSES = [
  'plugin-sliding-panes',
  'plugin-sliding-panes-rotate-header',
  'plugin-sliding-panes-header-alt',
  'plugin-sliding-panes-stacking',
  'plugin-sliding-panes-smooth',
  'plugin-sliding-select-orientation-mixed',
  'plugin-sliding-select-orientation-upright',
  'plugin-sliding-select-orientation-sideway',
];

// Collect every document we need to style: the main window, plus any popout
// windows (reached via their tab groups' ownerDocument).
function collectDocuments(app: App): Document[] {
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

// The three orientation classes are mutually exclusive; only one is on.
function applyOrientationClass(body: HTMLElement, orientation: Orientation): void {
  body.classList.toggle('plugin-sliding-select-orientation-mixed', orientation === 'mixed');
  body.classList.toggle('plugin-sliding-select-orientation-upright', orientation === 'upright');
  body.classList.toggle('plugin-sliding-select-orientation-sideway', orientation === 'sideway');
}

function applyBodyClasses(body: HTMLElement, settings: SlidingPanesSettings): void {
  body.classList.add('plugin-sliding-panes');
  body.classList.toggle('plugin-sliding-panes-rotate-header', settings.rotateHeaders);
  body.classList.toggle('plugin-sliding-panes-header-alt', settings.headerAlt);
  body.classList.toggle('plugin-sliding-panes-stacking', settings.stackingEnabled);
  body.classList.toggle('plugin-sliding-panes-smooth', settings.smoothAnimation);
  applyOrientationClass(body, settings.orienation);
}

// Inject / update the <style> element that carries the settings-dependent CSS
// variables. width-manager still writes inline widths on leaves to win the
// fight with Obsidian; these variables are the CSS-level baseline.
function applyStyleElement(doc: Document, settings: SlidingPanesSettings): void {
  let styleElement = doc.getElementById(STYLE_ELEMENT_ID);
  if (!styleElement) {
    styleElement = doc.createElement('style');
    styleElement.id = STYLE_ELEMENT_ID;
    doc.head.appendChild(styleElement);
  }

  const cssLines = [
    'body.plugin-sliding-panes .mod-root .workspace-tabs.mod-stacked {',
    `  --tab-stacked-header-width: ${settings.headerWidth}px;`,
  ];
  // In auto-width mode the real width is computed per group by width-manager
  // (inline styles), so publishing a fixed variable would just be misleading.
  if (!settings.leafAutoWidth) {
    cssLines.push(`  --tab-stacked-pane-width: ${getFixedWidth(settings)}px;`);
  }
  cssLines.push('}');
  styleElement.textContent = cssLines.join('\n');
}

// Apply body classes + injected style across every open document.
// Safe to call repeatedly (e.g. after a popout window opens).
export function apply(app: App, settings: SlidingPanesSettings): void {
  const documents = collectDocuments(app);
  documents.forEach((doc) => {
    applyBodyClasses(doc.body, settings);
    applyStyleElement(doc, settings);
  });
}

// Remove the injected style element and every body class, in all open
// documents. Called on disable and unload — leaves nothing behind.
export function remove(app: App): void {
  const documents = collectDocuments(app);
  documents.forEach((doc) => {
    const styleElement = doc.getElementById(STYLE_ELEMENT_ID);
    if (styleElement) {
      styleElement.remove();
    }
    ALL_BODY_CLASSES.forEach((className) => {
      doc.body.classList.remove(className);
    });
  });
}
