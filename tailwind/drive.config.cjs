/**
 * @file tailwind/drive.config.cjs
 * @description Tailwind v3 build config for the drive / file manager (private/drive.html).
 * The theme is copied verbatim from the page's former inline `tailwind.config` so the
 * precompiled stylesheet renders identically to the old browser/CDN build.
 *
 * Generated input — edit the theme here (not in the HTML), then `npm run build:css`.
 */
module.exports = {
  content: ["./private/drive.html","./public/**/*.js"],
  darkMode: 'class',
  theme: {
    extend: {
          "colors": {
                "primary": "#0b57d0",
                "on-primary": "#ffffff",
                "primary-container": "#dae2ff",
                "on-primary-container": "#001a41",
                "surface": "#f7f9ff",
                "surface-bright": "#f7f9ff",
                "surface-container-lowest": "#ffffff",
                "surface-container-low": "#f1f4fa",
                "surface-container": "#ebeef4",
                "surface-container-high": "#e5e8ee",
                "surface-container-highest": "#dfe3e8",
                "on-surface": "#181c20",
                "on-surface-variant": "#424654",
                "outline": "#737785",
                "outline-variant": "#c3c6d6",
                "secondary-container": "#d8e2ff",
                "on-secondary-container": "#001a41",
                "error": "#ba1a1a",
                "on-error": "#ffffff"
          },
          "fontFamily": {
                "sans": [
                      "Roboto",
                      "sans-serif"
                ]
          }
    }
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')]
};
