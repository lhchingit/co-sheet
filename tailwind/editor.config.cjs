/**
 * @file tailwind/editor.config.cjs
 * @description Tailwind v3 build config for the spreadsheet editor (private/index.html).
 * The theme is copied verbatim from the page's former inline `tailwind.config` so the
 * precompiled stylesheet renders identically to the old browser/CDN build.
 *
 * Generated input — edit the theme here (not in the HTML), then `npm run build:css`.
 */
module.exports = {
  content: ["./private/index.html","./public/**/*.js"],
  // The menu-bar opener's active state (app.js) toggles this utility on at
  // runtime, so it never appears as a bare class in scanned markup (only the
  // `hover:` variant does). Safelist it so the bare rule is always compiled.
  safelist: ["bg-surface-container-high"],
  darkMode: 'class',
  theme: {
    extend: {
          "colors": {
                "surface-variant": "#dfe3e8",
                "on-secondary": "#ffffff",
                "surface-container-low": "#f1f4fa",
                "inverse-surface": "#2d3135",
                "on-secondary-fixed-variant": "#004493",
                "error": "#ba1a1a",
                "on-secondary-fixed": "#001a41",
                "on-secondary-container": "#fefcff",
                "surface-container": "#ebeef4",
                "secondary-container": "#1471e6",
                "primary-fixed-dim": "#b2c5ff",
                "tertiary-fixed-dim": "#ffb599",
                "on-background": "#181c20",
                "inverse-on-surface": "#eef1f7",
                "on-error": "#ffffff",
                "surface-dim": "#d7dae0",
                "tertiary-container": "#a83b00",
                "secondary-fixed-dim": "#adc7ff",
                "secondary-fixed": "#d8e2ff",
                "on-primary": "#ffffff",
                "on-tertiary-fixed-variant": "#7f2b00",
                "on-tertiary": "#ffffff",
                "outline-variant": "#c3c6d6",
                "surface-tint": "#0856cf",
                "outline": "#737785",
                "tertiary-fixed": "#ffdbce",
                "primary": "#0041a2",
                "surface-bright": "#f7f9ff",
                "surface-container-highest": "#dfe3e8",
                "secondary": "#0058bb",
                "primary-container": "#0b57d0",
                "surface": "#f7f9ff",
                "on-surface": "#181c20",
                "primary-fixed": "#dae2ff",
                "inverse-primary": "#b2c5ff",
                "on-tertiary-fixed": "#370e00",
                "on-primary-fixed-variant": "#0040a1",
                "background": "#f7f9ff",
                "error-container": "#ffdad6",
                "on-primary-container": "#ced9ff",
                "on-surface-variant": "#424654",
                "on-error-container": "#93000a",
                "surface-container-high": "#e5e8ee",
                "surface-container-lowest": "#ffffff",
                "on-primary-fixed": "#001847",
                "tertiary": "#802b00",
                "on-tertiary-container": "#ffcfbe"
          },
          "borderRadius": {
                "DEFAULT": "0.125rem",
                "lg": "0.25rem",
                "xl": "0.5rem",
                "full": "0.75rem"
          },
          "spacing": {
                "icon-size-sm": "18px",
                "cell-padding-x": "6px",
                "cell-padding-y": "2px",
                "formula-bar-height": "32px",
                "gutter-header": "24px",
                "toolbar-height": "40px"
          },
          "fontFamily": {
                "mono-data": [
                      "JetBrains Mono"
                ],
                "headline-md": [
                      "Roboto"
                ],
                "label-md": [
                      "Roboto"
                ],
                "label-lg": [
                      "Roboto"
                ],
                "body-sm": [
                      "Roboto"
                ],
                "body-md": [
                      "Roboto"
                ]
          },
          "fontSize": {
                "mono-data": [
                      "13px",
                      {
                            "lineHeight": "20px",
                            "fontWeight": "400"
                      }
                ],
                "headline-md": [
                      "18px",
                      {
                            "lineHeight": "24px",
                            "fontWeight": "400"
                      }
                ],
                "label-md": [
                      "12px",
                      {
                            "lineHeight": "16px",
                            "fontWeight": "500"
                      }
                ],
                "label-lg": [
                      "14px",
                      {
                            "lineHeight": "20px",
                            "fontWeight": "500"
                      }
                ],
                "body-sm": [
                      "12px",
                      {
                            "lineHeight": "16px",
                            "fontWeight": "400"
                      }
                ],
                "body-md": [
                      "13px",
                      {
                            "lineHeight": "20px",
                            "fontWeight": "400"
                      }
                ]
          }
    }
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')]
};
