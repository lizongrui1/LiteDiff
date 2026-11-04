/**
 * Frontend entry point.
 *
 * Mounts the app and installs the CSS variables from the design tokens before
 * the first paint, so there is no flash of unstyled chrome.
 */

import { mount } from "svelte";
import App from "./App.svelte";
import "./global.css";
import { applyPalette, dark, light } from "./lib/theme";

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
applyPalette(prefersDark ? dark : light);

const target = document.getElementById("app");
if (!target) throw new Error("#app mount point missing");

export default mount(App, { target });

// Tauri suppresses the browser context menu by default; a diff view wants it
// (copy/paste/select all), so re-enable it explicitly.
window.addEventListener("contextmenu", (event) => {
  event.stopPropagation();
});
