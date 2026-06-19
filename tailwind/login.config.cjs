/**
 * @file tailwind/login.config.cjs
 * @description Tailwind v3 build config for the login page (public/login.html).
 * The login page uses only stock Tailwind utilities (slate/blue/etc.), so there is
 * no custom theme — just the default palette.
 *
 * Generated input — edit here (not in the HTML), then `npm run build:css`.
 */
module.exports = {
  content: ['./public/login.html'],
  darkMode: 'class',
  theme: { extend: {} },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')]
};
