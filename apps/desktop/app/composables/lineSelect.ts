/** Selection head on typed line: letter, or word with Ctrl (split on spaces: paths stay
 *  whole); Home/End to ends. */
export function moveHead(text: string, head: number, key: string, word: boolean) {
  if (key === "Home") return 0;
  if (key === "End") return text.length;
  const left = key === "ArrowLeft";
  if (!word) return Math.min(Math.max(head + (left ? -1 : 1), 0), text.length);
  let i = head;
  const space = (j: number) => /\s/.test(text[j] ?? "");
  if (left) {
    while (i > 0 && space(i - 1)) i--;
    while (i > 0 && !space(i - 1)) i--;
  } else {
    while (i < text.length && space(i)) i++;
    while (i < text.length && !space(i)) i++;
  }
  return i;
}
