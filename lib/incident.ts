export interface ScriptVersionLike {
  readonly id?: string;
  readonly tag?: string;
}

export type DeployIdSource =
  | "script_version_id"
  | "script_version_tag"
  | "missing";

export type IncidentSignatureSource = "stack" | "message";

export interface IncidentSignatureInput {
  readonly errorClass?: string;
  readonly message: string;
  readonly route: string;
  readonly service: string;
  readonly stackTrace: string;
  readonly statusCode: number;
}

export interface IncidentSignature {
  readonly errorClass: string;
  readonly key: string;
  readonly source: IncidentSignatureSource;
}

const INCIDENT_SIGNATURE_VERSION = "v1";
const MESSAGE_PREFIX_LIMIT = 120;

export function getDeployIdFromScriptVersion(
  scriptVersion?: ScriptVersionLike,
): string {
  const id = normalizeDeployValue(scriptVersion?.id);

  if (id !== "") {
    return id;
  }

  return normalizeDeployValue(scriptVersion?.tag);
}

export function getDeployIdSource(
  scriptVersion?: ScriptVersionLike,
): DeployIdSource {
  if (normalizeDeployValue(scriptVersion?.id) !== "") {
    return "script_version_id";
  }

  if (normalizeDeployValue(scriptVersion?.tag) !== "") {
    return "script_version_tag";
  }

  return "missing";
}

export function getIncidentSignature(
  input: IncidentSignatureInput,
): IncidentSignature {
  const errorClass = getIncidentErrorClass(input);
  const frame = getTopFrame(input.stackTrace);

  if (frame !== "") {
    return {
      errorClass,
      key: [
        INCIDENT_SIGNATURE_VERSION,
        "stack",
        normalizePart(input.service),
        errorClass,
        frame,
      ].join("|"),
      source: "stack",
    };
  }

  return {
    errorClass,
    key: [
      INCIDENT_SIGNATURE_VERSION,
      "message",
      normalizePart(input.service),
      normalizePart(input.route),
      normalizeStatusCode(input.statusCode),
      normalizeMessagePrefix(input.message),
    ].join("|"),
    source: "message",
  };
}

function getIncidentErrorClass(
  input: Pick<IncidentSignatureInput, "errorClass" | "message" | "stackTrace">,
): string {
  const direct = normalizeClass(input.errorClass ?? "");

  if (direct !== "") {
    return direct;
  }

  const stack = normalizeClass(firstLine(input.stackTrace));

  if (stack !== "") {
    return stack;
  }

  const message = normalizeClass(input.message);

  if (message !== "") {
    return message;
  }

  return "error";
}

function getTopFrame(stackTrace: string): string {
  for (const raw of stackTrace.split("\n")) {
    const line = collapseWhitespace(raw).trim();

    if (line === "") {
      continue;
    }

    if (line.startsWith("at ")) {
      return normalizeFrame(line.slice(3));
    }

    if (line.includes("@")) {
      return normalizeFrame(line);
    }
  }

  return "";
}

function normalizeClass(value: string): string {
  const name = collapseWhitespace(value).split(":")[0]?.trim() ?? "";

  if (name === "") {
    return "";
  }

  const text = name.match(/\b[A-Za-z]+(?:Error|Exception)\b/i)?.[0] ?? "";

  if (text === "") {
    return "";
  }

  return text.toLowerCase();
}

function normalizeFrame(value: string): string {
  const text = sanitizePart(
    collapseWhitespace(value)
      .replace(/(?::\d+){1,2}(\)?)$/, "$1")
      .trim(),
  );

  if (text !== "") {
    return text;
  }

  return "unknown";
}

function normalizeMessagePrefix(message: string): string {
  const text = sanitizePart(
    collapseWhitespace(message)
      .toLowerCase()
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, ":id")
      .replace(/\b[0-9a-f]{8,}\b/g, ":id")
      .replace(/\b\d{3,}\b/g, ":n")
      .slice(0, MESSAGE_PREFIX_LIMIT)
      .trim(),
  );

  if (text !== "") {
    return text;
  }

  return "unknown";
}

function normalizePart(value: string): string {
  const text = sanitizePart(collapseWhitespace(value).trim().toLowerCase());

  if (text !== "") {
    return text;
  }

  return "unknown";
}

function normalizeStatusCode(statusCode: number): string {
  if (!Number.isFinite(statusCode) || statusCode <= 0) {
    return "0";
  }

  return String(Math.trunc(statusCode));
}

function normalizeDeployValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

function firstLine(value: string): string {
  for (const raw of value.split("\n")) {
    const line = raw.trim();

    if (line !== "") {
      return line;
    }
  }

  return "";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function sanitizePart(value: string): string {
  return value.replaceAll("|", "/");
}
