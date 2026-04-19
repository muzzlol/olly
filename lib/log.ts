export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
}

export function createLogger(
  service: string,
  context: LogFields = {},
): Logger {
  return {
    debug(event, fields) {
      writeLog("debug", service, context, event, fields);
    },
    info(event, fields) {
      writeLog("info", service, context, event, fields);
    },
    warn(event, fields) {
      writeLog("warn", service, context, event, fields);
    },
    error(event, fields) {
      writeLog("error", service, context, event, fields);
    },
  };
}

function writeLog(
  level: LogLevel,
  service: string,
  context: LogFields,
  event: string,
  fields: LogFields = {},
) {
  // Emit one JSON object per line so Workers tailing and local tooling see the same shape.
  const line = JSON.stringify(
    {
      ts: new Date().toISOString(),
      service,
      level,
      event,
      ...context,
      ...fields,
    },
    (_key, value: unknown) => serializeValue(value),
  );

  if (level === "debug") {
    console.debug(line);
    return;
  }

  if (level === "info") {
    console.info(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.error(line);
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return toSerializedError(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function toSerializedError(value: Error): SerializedError {
  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
    cause: value.cause,
  };
}
