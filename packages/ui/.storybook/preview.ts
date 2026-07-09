import { withThemeByDataAttribute } from "@storybook/addon-themes";

// Aggregates tokens.css plus every component stylesheet — the same entry applications import.
import "../src/styles.css";

export default {
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    withThemeByDataAttribute({
      themes: {
        light: "light",
        dark: "dark",
      },
      defaultTheme: "light",
      attributeName: "data-theme",
      parentSelector: "html",
    }),
  ],
};
