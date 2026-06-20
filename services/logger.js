// @ts-check

/**
 * @file services/logger.js
 * @description Centralized structured logger for the server. Wraps pino so the rest
 * of the codebase logs through a single configured instance instead of raw
 * console.* calls. Emits one JSON object per line (level, time, component, msg),
 * which log collectors (Loki, CloudWatch, Datadog, …) ingest directly.
 *
 * Level is taken from LOG_LEVEL (default 'info'); set LOG_LEVEL=debug for verbose
 * output or LOG_LEVEL=silent to mute. Components that previously used bracket tags
 * (e.g. '[session]') now get a dedicated child logger via component(); the tag
 * becomes the structured `component` field rather than free text in the message.
 */

import pino from 'pino';

/**
 * Root logger. ISO-8601 timestamps (rather than pino's default epoch millis) keep
 * the lines human-scannable while staying machine-parseable.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Returns a child logger that tags every line with a `component` field. Use one
 * per subsystem (e.g. component('ws'), component('autosave')) so logs can be
 * filtered by area without grepping message text.
 * @param {string} name
 * @returns {import('pino').Logger}
 */
export const component = (name) => logger.child({ component: name });
