import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // The diff view is not a document: no dev-mode a11y noise for the code
    // rows, which are pure presentation with pointer affordances.
    warningFilter: (warning) =>
      !(
        warning.code === "a11y_no_static_element_interactions" ||
        warning.code === "a11y_click_events_have_key_events"
      ),
  },
};
