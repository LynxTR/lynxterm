// Completions from Fig specs (@withfig/autocomplete). One chunk per command, loaded on first use.
// Spec generators and other functions never run: they execute commands, here on the server.

type Named = { name: string | string[]; description?: string; hidden?: boolean; priority?: number };
type Arg = { suggestions?: (string | Named)[]; isOptional?: boolean };
type Option = Named & { args?: Arg | Arg[]; isPersistent?: boolean };
interface Spec extends Named {
  subcommands?: Spec[];
  options?: Option[];
  args?: Arg | Arg[];
  loadSpec?: string;
}
export type Completion = { text: string; hint?: string };

const DIR = "../../node_modules/@withfig/autocomplete/build/";
const files = import.meta.glob<Spec>("../../node_modules/@withfig/autocomplete/build/**/*.js", {
  import: "default",
});
const specs = new Map<string, Spec | null>(); // null: no spec, or still loading

/** Spec at `path` ("git", "dotnet/dotnet-add"); undefined until loaded, then `onLoad` runs once. */
function load(path: string, onLoad: () => void) {
  if (specs.has(path)) return specs.get(path) ?? undefined;
  specs.set(path, null);
  const file = files[`${DIR}${path}.js`] ?? files[`${DIR}${path}/index.js`];
  file?.().then(
    (spec) => {
      if (typeof spec !== "object" || Array.isArray(spec)) return;
      specs.set(path, spec);
      onLoad();
    },
    () => {},
  ); // broken spec: no completions
}

const names = (x: Named) => [x.name].flat();
const takesValue = (o?: Option) => !!o?.args && [o.args].flat().some((a) => !a.isOptional);

/** Last word: subcommands and argument values, or options once it starts with "-". Command
 *  itself comes from PATH. */
export function figComplete(line: string, onLoad: () => void): Completion[] {
  const words = line.trimStart().split(/ +/); // ignores quoting, fine for flags
  if (words[0] === "sudo") words.shift();
  const partial = words.pop()!;
  if (!words.length) return [];
  let node = load(words[0]!, onLoad);
  const inherited: Option[] = []; // parents' persistent options
  for (let i = 1; node && i < words.length; i++) {
    const word = words[i]!;
    const options = [...(node.options ?? []), ...inherited];
    if (word.startsWith("-")) {
      if (takesValue(options.find((o) => names(o).includes(word)))) i++;
      continue;
    }
    const sub = node.subcommands?.find((s) => names(s).includes(word));
    if (!sub) continue; // an argument
    inherited.push(...(node.options ?? []).filter((o) => o.isPersistent));
    node = sub.loadSpec ? load(sub.loadSpec, onLoad) : sub;
  }
  if (!node) return [];

  const pool: Named[] = partial.startsWith("-")
    ? [...(node.options ?? []), ...inherited]
    : [
        ...(node.subcommands ?? []),
        ...[node.args ?? []]
          .flat()
          .flatMap((a) => a.suggestions ?? [])
          .map((s) => (typeof s === "string" ? { name: s } : s)),
      ];
  const start = line.slice(0, line.length - partial.length);
  return pool
    .filter((x) => !x.hidden)
    .toSorted((a, b) => (b.priority ?? 50) - (a.priority ?? 50))
    .flatMap((x) => {
      const name = names(x).find((n) => n.startsWith(partial) && n !== partial);
      return name ? [{ text: start + name, hint: x.description }] : [];
    });
}
