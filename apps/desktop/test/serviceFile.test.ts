import { expect, test } from "vite-plus/test";
import {
  fixServiceFile,
  highlightSh,
  lintServiceFile,
  parseServiceFile,
  serviceFile,
  shError,
} from "../app/composables/serviceFile";

const docker = {
  shared: 'PKGS="docker-ce"\nhelper() {\n  echo hi\n}',
  functions: {
    detect: "command -v docker || return 1\ndocker --version",
    check: 'if true; then\n  echo "ok"\nfi',
  },
};

test("file and back keeps every part", () => {
  const file = serviceFile(docker);
  expect(file.split("\n")[5]).toBe("detect() {");
  expect(file).toContain('\n  echo "ok"\n');
  expect(file.endsWith('}\n"$@"')).toBe(true);
  expect(parseServiceFile(file)).toEqual(docker);
});

test("raw edits that don't split into functions name the line", () => {
  expect(parseServiceFile("detect() {\n  x\n}\nstray")).toEqual({
    error: "Only functions down here: move this line into shared",
    line: 4,
  });
  expect(parseServiceFile("detect() {\n  x\ncheck() {\n}")).toMatchObject({ line: 1 });
  expect(parseServiceFile("detect() {\n}\ndetect() {\n}")).toMatchObject({ line: 3 });
  expect(parseServiceFile("echo hi")).toEqual({ error: "detect() is required", line: 1 });
});

test("} inside a heredoc doesn't end the function; exit in a helper is flagged", () => {
  const json = {
    shared: "",
    functions: { detect: "true", fix: "cat <<EOF\n{\n}\nEOF\necho done" },
  };
  expect(parseServiceFile(serviceFile(json))).toEqual(json);
  const helper = serviceFile({ shared: "helper() {\n  exit 1\n}", functions: { detect: "true" } });
  expect(lintServiceFile(helper)).toMatchObject([
    { line: 3, error: "exit ends the whole run: use return" },
  ]);
});

test("lint flags bash-only syntax and exit, skips comments and heredocs", () => {
  const file = serviceFile({
    shared: "function helper {\n  :\n}\n# [[ fine in a comment ]]\ngrep -q '^x[[:space:]]' f",
    functions: {
      detect: "if [[ -x /usr/bin/docker ]]; then\n  docker --version \nfi\ncommand -v x || exit 1",
      fix: "sudo sh -s <<'EOF'\n[[ inside heredoc ]] || exit 2\nEOF\n[ \"$a\" == b ] && echo ok",
    },
  });
  expect(lintServiceFile(file)).toMatchObject([
    { line: 2, error: "function is bash only: use name() {" },
    { line: 8, error: "[[ is bash only: use [ ]" },
    { line: 9, error: "Trailing space" },
    { line: 11, error: "exit ends the whole run: use return" },
    { line: 17, error: "== in [ ] is bash only: use =" },
  ]);
  expect(lintServiceFile(serviceFile(docker))).toEqual([]);

  const fixed = fixServiceFile(file).split("\n");
  expect(fixed[1]).toBe("helper() {");
  expect(fixed[7]).toBe("if [ -x /usr/bin/docker ]; then");
  expect(fixed[8]).toBe("  docker --version");
  expect(fixed[10]).toBe("command -v x || return 1");
  expect(fixed[14]).toBe("[[ inside heredoc ]] || exit 2");
  expect(fixed[16]).toBe('[ "$a" = b ] && echo ok');
  expect(lintServiceFile(fixed.join("\n"))).toEqual([]);
});

test("fix leaves [[ ]] that [ ] would read differently", () => {
  const file = serviceFile({ shared: "", functions: { detect: '[[ "$v" == 2* ]] && return 0' } });
  expect(fixServiceFile(file)).toBe(file);
  expect(lintServiceFile(file)[0]).toEqual({ line: 4, error: "[[ is bash only: use [ ]" });
});

test("sh errors from dash and bash", () => {
  expect(shError('sh: 12: Syntax error: end of file unexpected (expecting "}")')).toEqual({
    line: 12,
    error: 'Syntax error: end of file unexpected (expecting "}")',
  });
  expect(shError("sh: line 7: syntax error near unexpected token `}'")).toEqual({
    line: 7,
    error: "syntax error near unexpected token `}'",
  });
});

test("sh colors: strings, variables, comments, keywords, escaped html", () => {
  const html = highlightSh('if [ -n "$1" ]; then echo $HOME <x # note\nfi');
  expect(html).toContain('<span class="text-violet-300">if</span>');
  expect(html).toContain('<span class="text-emerald-300">&#34;$1&#34;</span>');
  expect(html).toContain('<span class="text-sky-300">$HOME</span>');
  expect(html).toContain('<span class="text-muted">&#60;</span>x');
  expect(html).toContain('<span class="text-dimmed italic"># note</span>');
  expect(highlightSh("a#b")).toBe("a#b");
  expect(highlightSh("write_conf() {")).toContain('<span class="text-amber-200">write_conf</span>');
});

test("single-quoted text is data, not shell", () => {
  const file = serviceFile({
    shared: "",
    functions: { detect: "awk '{ exit }' f\nsed 's/[[ x/y/' f" },
  });
  expect(lintServiceFile(file)).toEqual([]);
});
