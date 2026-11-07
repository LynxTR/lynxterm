// Setup typed only at shell prompt. Login may still ask (Hetzner forced password change,
// sudo, profile passphrase): setup line would become the answer.
const ASKING = /password|passphrase|yes\/no|'yes'|^(Enter|Allow) /i;
const PROMPT = /[$#%>❯│⟫»▶λ→] $/;

/** Cursor line up to cursor: login question, shell prompt, or can't tell. */
export const lineKind = (line: string) =>
  ASKING.test(line) ? "asking" : PROMPT.test(line) ? "prompt" : "unsure";
