import { withThemeByDataAttribute } from "@storybook/addon-themes";

import "../src/tokens.css";

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
