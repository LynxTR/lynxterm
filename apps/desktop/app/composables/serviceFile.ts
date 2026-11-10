// Editor line numbers match this file, so sh errors point at right line.
import { escapeHtml } from "./termHtml";

export const SERVICE_FUNCTIONS = [
  {
    name: "detect",
    hint: "background, exit 0 if installed, line 1 version, optional update: X",
    example: "command -v docker >/dev/null || return 1\ndocker --version",
  },
  {
    name: "preflight",
    hint: "background, 0 ready, 1 warning, 2 blocked, one finding per line",
    example: 'command -v colima >/dev/null && { echo "conflict: colima"; return 2; }\nreturn 0',
  },
  {
    name: "install",
    hint: "terminal",
    example: "preflight; [ $? -lt 2 ] || return 2\ncurl -fsSL https://get.docker.com | sudo sh",
  },
  {
    name: "check",
    hint: "background, 0 ok, 1 warning, 2 critical, 3 unknown, line 1 summary",
    example: 'systemctl is-active -q docker || { echo "daemon down"; return 2; }\necho "running"',
  },
  {
    name: "logs",
    hint: "terminal, argument: row name",
    example: "journalctl -u docker -n 200 -f",
  },
  {
    name: "fix",
    hint: "terminal, offered when check fails",
    example: "sudo systemctl restart docker",
  },
  {
    name: "upgrade",
    hint: "terminal, offered on update: line",
    example: "sudo apt-get install -y --only-upgrade docker-ce",
  },
  {
    name: "uninstall",
    hint: "terminal, asks first, keep data",
    example: "sudo apt-get remove -y docker-ce",
  },
] as const;
export type ServiceFunction = (typeof SERVICE_FUNCTIONS)[number]["name"];

export interface Service {
  id?: string;
  name: string;
  description: string;
  checkOnConnect: boolean;
  checkEvery: number;
  shared: string;
  functions: Partial<Record<ServiceFunction, string>>;
  why: string;
  fixLabel: string;
}
type Code = Pick<Service, "shared" | "functions">;

export const newService = (): Service => ({
  name: "",
  description: "",
  checkOnConnect: false,
  checkEvery: 0,
  shared: "",
  functions: { detect: "" },
  why: "",
  fixLabel: "",
});

export const SHARED_LINE = "# shared: variables and helpers";
const NAMES: readonly string[] = SERVICE_FUNCTIONS.map((f) => f.name);
const functionName = (line: string) => {
  const name = line.match(/^(\w+)\s*\(\)\s*\{\s*$/)?.[1];
  return name && NAMES.includes(name) ? (name as ServiceFunction) : undefined;
};

/** Bodies as typed, not indented: heredoc end marker must stay at line start. */
export function serviceFile(s: Code) {
  const lines = [SHARED_LINE, s.shared];
  for (const { name } of SERVICE_FUNCTIONS) {
    const body = s.functions[name];
    if (body !== undefined) lines.push(`${name}() {`, body, "}");
  }
  lines.push('"$@"');
  return lines.join("\n");
}

const heredocStart = (line: string) =>
  line.includes("<<<") ? "" : (line.match(/<<-?\s*['"]?(\w+)/)?.[1] ?? "");

/** Function runs from `name() {` to first `}` at line start, heredoc text
 *  skipped (a JSON `}` there is not the end). */
export function parseServiceFile(text: string): Code | { error: string; line: number } {
  const lines = text.split("\n");
  let i = lines[0] === SHARED_LINE ? 1 : 0;
  const shared: string[] = [];
  for (; i < lines.length && !functionName(lines[i]!) && lines[i] !== '"$@"'; i++)
    shared.push(lines[i]!);

  const functions: Code["functions"] = {};
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line === '"$@"') continue;
    const name = functionName(line);
    if (!name)
      return { error: "Only functions down here: move this line into shared", line: i + 1 };
    if (functions[name] !== undefined) return { error: `${name}() is here twice`, line: i + 1 };
    let end = i + 1;
    for (let heredoc = ""; end < lines.length; end++) {
      const l = lines[end]!;
      if (heredoc) {
        if (l.trim() === heredoc) heredoc = "";
      } else if (l === "}" || functionName(l)) break;
      else heredoc = heredocStart(l);
    }
    if (lines[end] !== "}") return { error: `${name}() needs } at line start`, line: i + 1 };
    functions[name] = lines.slice(i + 1, end).join("\n");
    i = end;
  }
  if (functions.detect === undefined) return { error: "detect() is required", line: 1 };
  return { shared: shared.join("\n"), functions };
}

export function serviceFromFile(text: string): Service | { error: string; line: number } {
  const parts = parseServiceFile(text);
  if ("error" in parts) return parts;
  const service = { ...newService(), ...parts };
  const field = { name: "name", description: "description", why: "why", fix: "fixLabel" } as const;
  service.shared = parts.shared
    .split("\n")
    .filter((line) => {
      const m = line.match(/^# (name|description|why|fix): (.*)$/);
      if (m) service[field[m[1] as keyof typeof field]] = m[2]!;
      return !m;
    })
    .join("\n");
  return service;
}

// Valid syntax that still breaks: Debian and Ubuntu sh is dash, no bash extras. fix: rewrite
// line when it's safe; [[ ]] only without &&, ||, =~, < > or globs, which [ ] reads differently.
type Rule = { test: RegExp; error: string; fix?: (line: string) => string; inFunction?: true };
const TRAILING: Rule = { test: /\s$/, error: "Trailing space", fix: (l) => l.trimEnd() };
const RULES: Rule[] = [
  TRAILING,
  {
    // Space after: [[:space:]] in grep and sed patterns is plain sh.
    test: /\[\[\s/,
    error: "[[ is bash only: use [ ]",
    fix: (l) =>
      l.replace(/\[\[ (.*?) \]\]/g, (m, inner: string) =>
        /&&|\|\||=~|[<>*?]/.test(inner) ? m : `[ ${inner} ]`,
      ),
  },
  {
    test: /^\s*function\s+\w+/,
    error: "function is bash only: use name() {",
    fix: (l) => l.replace(/^(\s*)function\s+(\w+)(\s*\(\))?/, "$1$2()"),
  },
  {
    test: /(^|[;&|{]\s*)source\s/,
    error: "source is bash only: use .",
    fix: (l) => l.replace(/(^|[;&|{]\s*)source\s/g, "$1. "),
  },
  {
    test: /&>/,
    error: "&> is bash only: use >file 2>&1",
    fix: (l) => l.replace(/&>\s*(\S+)/g, ">$1 2>&1"),
  },
  { test: /<<</, error: "<<< is bash only: pipe printf into it" },
  { test: /\becho\s+-e\b/, error: "echo -e differs between shells: use printf" },
  {
    // Single [ only: [[ ]] has its own warning, and == there is a pattern match.
    test: /(^|[^[])\[\s[^\]]*\s==\s/,
    error: "== in [ ] is bash only: use =",
    fix: (l) => l.replace(/(^|[^[])(\[\s[^\]]*\s)==(\s)/g, "$1$2=$3"),
  },
  {
    test: /(^\s*|[;&|{]\s*|\b(then|else|do)\s+)exit\b/,
    error: "exit ends the whole run: use return",
    fix: (l) => l.replace(/(^\s*|[;&|{]\s*|\b(?:then|else|do)\s+)exit\b/g, "$1return"),
    inFunction: true,
  },
];

interface LintWarning {
  line: number;
  error: string;
  fixed?: string;
}

export function lintServiceFile(text: string) {
  const found: LintWarning[] = [];
  let inFunction = false;
  let heredoc = "";
  text.split("\n").forEach((line, i) => {
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = "";
      return;
    }
    // Any function, shared helpers too: exit there ends the run as well.
    if (/^\s*\w+\s*\(\)\s*\{/.test(line)) inFunction = true;
    else if (line === "}") inFunction = false;
    const comment = line.trimStart().startsWith("#");
    // Single-quoted text is data (an awk program's exit, a sed pattern), not shell.
    const code = line.replace(/'[^']*'/g, "''");
    for (const rule of RULES) {
      if (comment && rule !== TRAILING) continue;
      if ((rule.inFunction && !inFunction) || !rule.test.test(rule === TRAILING ? line : code))
        continue;
      const fixed = rule.fix?.(line) ?? line;
      found.push({ line: i + 1, error: rule.error, ...(fixed !== line && { fixed }) });
    }
    heredoc = heredocStart(line);
  });
  return found;
}

export function applyFix(text: string, w: LintWarning) {
  const lines = text.split("\n");
  lines[w.line - 1] = w.fixed!;
  return lines.join("\n");
}

/** Every safe fix, one at a time, so fixes on one line stack. */
export function fixServiceFile(text: string) {
  const next = (t: string) => lintServiceFile(t).find((w) => w.fixed !== undefined);
  for (let w = next(text); w; w = next(text)) text = applyFix(text, w);
  return text;
}

/** sh error to line and text: dash `sh: 12: Syntax error...`, bash `sh: line 12: syntax...`. */
export function shError(message: string) {
  const m = message.match(/^[^:]*:\s*(?:line\s+)?(\d+):\s*(.*)$/);
  return m ? { line: Number(m[1]), error: m[2]! } : { line: 0, error: message };
}

const SH_COLORS = [
  "text-dimmed italic", // comment
  "text-emerald-300", // string
  "text-sky-300", // variable
  "text-violet-300", // keyword
  "text-amber-200", // function name
  "text-orange-300", // number
  "text-muted", // operator
];
// Groups in SH_COLORS order.
const SH_TOKEN =
  /(#.*)|('[^']*'?|"(?:\\.|[^"\\])*"?)|(\$\{[^}]*\}?|\$\(\(?|\$(?:\w+|[?#@*!$-])?)|\b(if|then|else|elif|fi|for|while|until|do|done|case|esac|in|return|local|export|function)\b|([A-Za-z_]\w*)(?=\s*\(\))|\b(\d+)\b|(&&|\|\||[|;&<>]+)/g;

export function highlightSh(code: string) {
  const re = new RegExp(SH_TOKEN);
  let html = "";
  let last = 0;
  for (let m; (m = re.exec(code));) {
    // # starts a comment only at line start or after space or ;, else it's text (a#b).
    if (m[1] && m.index > 0 && !/[\s;]/.test(code[m.index - 1]!)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const color = SH_COLORS[m.slice(1).findIndex(Boolean)];
    html += `${escapeHtml(code.slice(last, m.index))}<span class="${color}">${escapeHtml(m[0])}</span>`;
    last = re.lastIndex;
  }
  return html + escapeHtml(code.slice(last));
}
