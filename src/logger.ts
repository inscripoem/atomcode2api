import { isatty } from 'node:tty';
import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

function buildLogger(): pino.Logger {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: isatty(1) ? 'pino-pretty' : 'pino/file',
      level: LOG_LEVEL,
    },
  ];

  // Attempt to add the file transport with daily rotation.
  // If pino-roll fails (e.g. directory creation fails), fall back to console-only.
  try {
    targets.push({
      target: 'pino-roll',
      options: {
        file: 'data/logs/app.log',
        frequency: 'daily',
        mkdir: true,
        limit: { count: 6 },
      },
      level: LOG_LEVEL,
    });
  } catch {
    // pino-roll transport unavailable, continuing with console-only
  }

  try {
    return pino({
      name: 'atomcode2api',
      level: LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: { targets },
    });
  } catch {
    // Full transport init failed — fall back to a plain console-only logger
    return pino({
      name: 'atomcode2api',
      level: LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
}

const logger = buildLogger();

export default logger;

export function createLogger(name: string): pino.Logger {
  return logger.child({ name });
}