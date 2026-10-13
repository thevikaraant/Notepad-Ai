/**
 * Cleans Markdown decoration out of an AI response before it lands in the
 * plain-text editor. NotepadAI's editor is a `<textarea>` -- it never
 * renders Markdown -- so headings, bold markers, and horizontal rules show
 * up to the user as literal #/**-- clutter instead of formatting. Code
 * blocks, inline code, and URLs are protected (left byte-for-byte untouched)
 * before any stripping runs, specifically to avoid the "blind regex
 * corrupts code or structured data" failure mode -- e.g. a double-star
 * exponentiation operator or a hash shell comment inside a fenced code
 * block must never be touched.
 */

// A NUL character can never appear in normal AI-response text, so it is a
// safe delimiter for internal placeholders. It is computed at runtime
// (never written as a raw byte in this source file) and is never visible to
// the user: every placeholder is restored before this module returns.
const NUL = String.fromCharCode(0);

function protect(text: string, pattern: RegExp, store: string[], tag: string): string {
  return text.replace(pattern, (match) => {
    store.push(match);
    return NUL + tag + (store.length - 1) + NUL;
  });
}

function restore(text: string, store: string[], tag: string): string {
  if (store.length === 0) return text;
  const pattern = new RegExp(NUL + tag + "(\\d+)" + NUL, "g");
  return text.replace(pattern, (_match, index: string) => store[Number(index)] ?? "");
}

const HORIZONTAL_RULE = /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$\n?/gm;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(?=\S)/gm;
const BOLD_STAR = /\*\*([^\n]+?)\*\*/g;
const BOLD_UNDERSCORE = /__([^\n]+?)__/g;
const BULLET = /^([ \t]*)[*+][ \t]+/gm;
const BLOCKQUOTE = /^[ \t]*>[ \t]?/gm;
const EXCESS_BLANK_LINES = /\n{3,}/g;

const FENCED_CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s)\]}>'"]+/g;

/** Formats a complete AI response into clean, narrative plain text, preserving code blocks, inline code, and URLs exactly as given. */
export function cleanAiResponseText(raw: string): string {
  if (!raw) return raw;

  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];
  const urls: string[] = [];

  let text = raw;
  text = protect(text, FENCED_CODE_BLOCK, codeBlocks, "CB");
  text = protect(text, INLINE_CODE, inlineCode, "IC");
  text = protect(text, URL_PATTERN, urls, "URL");

  text = text.replace(HORIZONTAL_RULE, "");
  text = text.replace(HEADING, "");
  text = text.replace(BOLD_STAR, "$1");
  text = text.replace(BOLD_UNDERSCORE, "$1");
  text = text.replace(BULLET, "$1- ");
  text = text.replace(BLOCKQUOTE, "");
  text = text.replace(EXCESS_BLANK_LINES, "\n\n");

  text = restore(text, urls, "URL");
  text = restore(text, inlineCode, "IC");
  text = restore(text, codeBlocks, "CB");

  return text.trim();
}
