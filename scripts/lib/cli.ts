// Tiny argv parser shared by every script. Zero deps by design.
export interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  opts: Map<string, string>;
}

/**
 * parseArgs(argv, ["dry", "help"], ["provider", "limit"])
 * Boolean flags take no value; opts consume the next token. `--key-file` is
 * always treated as an opt so it never lands in positional.
 */
export function parseArgs(
  argv: string[],
  boolFlags: string[] = [],
  valueOpts: string[] = [],
): ParsedArgs {
  const bools = new Set(boolFlags);
  const vals = new Set([...valueOpts, "key-file"]);
  const out: ParsedArgs = { positional: [], flags: new Set(), opts: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > -1 ? a.slice(2, eq) : a.slice(2);
    if (vals.has(name)) {
      const v = eq > -1 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      out.opts.set(name, v);
    } else if (bools.has(name)) {
      out.flags.add(name);
    } else {
      throw new Error(`unknown option --${name}`);
    }
  }
  return out;
}

export function usage(text: string, code = 1): never {
  console.error(text.trim());
  process.exit(code);
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** Parses --since/--until values (YYYY-MM-DD, or anything Date.parse accepts). Returns null on garbage. */
export function parseDateArg(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
