/**
 * A deliberately small YAML reader for operator-edited configuration files that
 * ship in this repository.
 *
 * The controller image carries no YAML dependency, and the one file it needs to
 * read (config/catalog-sources.yaml) uses only block mappings, block sequences,
 * and plain scalars. Rather than pull in a full parser for that, this handles
 * exactly that subset and throws on anything outside it — anchors, aliases,
 * tags, flow collections, block scalars, and multiple documents — so a file
 * using a feature this cannot represent fails loudly instead of being
 * misinterpreted.
 */

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
  }
}

interface Line {
  indent: number;
  text: string;
  number: number;
}

/** Strips an unquoted trailing comment without touching `#` inside a string. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function scan(source: string): Line[] {
  const lines: Line[] = [];
  source.split("\n").forEach((raw, index) => {
    const number = index + 1;
    const withoutTab = raw.replace(/\t/g, "    ");
    const text = stripComment(withoutTab);
    if (text.trim().length === 0) {
      return;
    }
    if (text.trim() === "---") {
      // A single leading document marker is harmless; a second means the file
      // holds more than one document, which this reader will not guess about.
      if (lines.length > 0) {
        throw new YamlError("multiple YAML documents are not supported", number);
      }
      return;
    }
    if (text.trim() === "...") {
      return;
    }
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), number });
  });
  return lines;
}

function unquote(value: string, line: number): string {
  const quote = value[0];
  if (value.length < 2 || value[value.length - 1] !== quote) {
    throw new YamlError("unterminated quoted scalar", line);
  }
  const body = value.slice(1, -1);
  if (quote === "'") {
    return body.replace(/''/g, "'");
  }
  return body.replace(/\\(["\\/nrt])/g, (_, escape: string) => {
    switch (escape) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escape;
    }
  });
}

function scalar(raw: string, line: number): unknown {
  const value = raw.trim();
  if (value.length === 0 || value === "~" || value === "null") {
    return null;
  }
  if (value[0] === '"' || value[0] === "'") {
    return unquote(value, line);
  }
  if ("&*!|>{[".includes(value[0])) {
    throw new YamlError(`unsupported YAML construct: ${value[0]}`, line);
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  if (/^[+-]?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) {
    return Number.parseFloat(value);
  }
  return value;
}

/** Splits `key: value`, ignoring colons inside quotes and inside URLs. */
function splitKey(text: string, line: number): [string, string] {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    // A key ends at a colon followed by whitespace or end of line, which is
    // what keeps `https://host/path` from splitting on its scheme colon.
    if (character === ":" && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      const raw = text.slice(0, index).trim();
      const key = raw[0] === '"' || raw[0] === "'" ? unquote(raw, line) : raw;
      if (key.length === 0) {
        throw new YamlError("mapping key must not be empty", line);
      }
      return [key, text.slice(index + 1).trim()];
    }
  }
  throw new YamlError(`expected 'key: value' but found ${JSON.stringify(text)}`, line);
}

function hasKey(text: string): boolean {
  try {
    splitKey(text, 0);
    return true;
  } catch {
    return false;
  }
}

interface Cursor {
  index: number;
}

function parseNode(lines: Line[], cursor: Cursor, indent: number): unknown {
  const line = lines[cursor.index];
  return line.text === "-" || line.text.startsWith("- ")
    ? parseSequence(lines, cursor, indent)
    : parseMapping(lines, cursor, indent);
}

/** Consumes a child block if the next line is indented past the parent. */
function parseChild(lines: Line[], cursor: Cursor, indent: number): unknown {
  const next = lines[cursor.index];
  if (next === undefined || next.indent <= indent) {
    return null;
  }
  return parseNode(lines, cursor, next.indent);
}

function parseMapping(
  lines: Line[],
  cursor: Cursor,
  indent: number
): Record<string, unknown> {
  const mapping: Record<string, unknown> = {};
  while (cursor.index < lines.length && lines[cursor.index].indent === indent) {
    const line = lines[cursor.index];
    if (line.text.startsWith("- ") || line.text === "-") {
      throw new YamlError("sequence item where a mapping key was expected", line.number);
    }
    const [key, rest] = splitKey(line.text, line.number);
    if (key in mapping) {
      throw new YamlError(`duplicate mapping key: ${key}`, line.number);
    }
    cursor.index += 1;
    mapping[key] =
      rest.length === 0 ? parseChild(lines, cursor, indent) : scalar(rest, line.number);
  }
  return mapping;
}

function parseSequence(lines: Line[], cursor: Cursor, indent: number): unknown[] {
  const items: unknown[] = [];
  while (
    cursor.index < lines.length &&
    lines[cursor.index].indent === indent &&
    (lines[cursor.index].text === "-" || lines[cursor.index].text.startsWith("- "))
  ) {
    const line = lines[cursor.index];
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    cursor.index += 1;
    if (rest.length === 0) {
      items.push(parseChild(lines, cursor, indent));
    } else if (hasKey(rest)) {
      // `- key: value` opens a mapping whose remaining keys are indented to
      // where that first key sits; re-inject it as a normal line at that column.
      const column = indent + 2;
      lines.splice(cursor.index, 0, { indent: column, text: rest, number: line.number });
      items.push(parseMapping(lines, cursor, column));
    } else {
      items.push(scalar(rest, line.number));
    }
  }
  return items;
}

export function parseYaml(source: string): unknown {
  const lines = scan(source);
  if (lines.length === 0) {
    return null;
  }
  const base = lines[0].indent;
  const cursor: Cursor = { index: 0 };
  const value = parseNode(lines, cursor, base);
  if (cursor.index < lines.length) {
    throw new YamlError("inconsistent indentation", lines[cursor.index].number);
  }
  return value;
}
