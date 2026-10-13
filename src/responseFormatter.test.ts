import { describe, expect, it } from "vitest";
import { cleanAiResponseText } from "./responseFormatter";

describe("cleanAiResponseText — decoration stripping", () => {
  it("strips ATX headings but keeps the heading text", () => {
    expect(cleanAiResponseText("# Summary\nSome text.")).toBe("Summary\nSome text.");
    expect(cleanAiResponseText("## Sub Heading")).toBe("Sub Heading");
    expect(cleanAiResponseText("###### Deep")).toBe("Deep");
  });

  it("does not treat a mid-line # as a heading", () => {
    expect(cleanAiResponseText("Use # to start a comment in Python.")).toBe(
      "Use # to start a comment in Python.",
    );
  });

  it("strips bold markers (** and __) but keeps the wrapped text", () => {
    expect(cleanAiResponseText("**Important:** do this.")).toBe("Important: do this.");
    expect(cleanAiResponseText("This is __also bold__ text.")).toBe("This is also bold text.");
  });

  it("strips horizontal rules in their common variants", () => {
    expect(cleanAiResponseText("Before\n---\nAfter")).toBe("Before\nAfter");
    expect(cleanAiResponseText("Before\n***\nAfter")).toBe("Before\nAfter");
    expect(cleanAiResponseText("Before\n* * *\nAfter")).toBe("Before\nAfter");
    expect(cleanAiResponseText("Before\n___\nAfter")).toBe("Before\nAfter");
  });

  it("normalizes * and + bullets to a plain dash, preserving indentation", () => {
    expect(cleanAiResponseText("* one\n* two")).toBe("- one\n- two");
    expect(cleanAiResponseText("+ one\n  + nested")).toBe("- one\n  - nested");
  });

  it("strips blockquote markers", () => {
    expect(cleanAiResponseText("> quoted line")).toBe("quoted line");
  });

  it("collapses 3+ blank lines down to one blank line", () => {
    expect(cleanAiResponseText("One\n\n\n\n\nTwo")).toBe("One\n\nTwo");
  });

  it("trims leading/trailing whitespace from the whole response", () => {
    expect(cleanAiResponseText("\n\n  Hello  \n\n")).toBe("Hello");
  });
});

describe("cleanAiResponseText — safe formatting (never corrupts code, math, or URLs)", () => {
  it("leaves a fenced code block completely untouched, including internal ** and #", () => {
    const input = "Here:\n```python\n# a comment\nresult = 2 ** 3\n**not markdown**\n```\nDone.";
    expect(cleanAiResponseText(input)).toBe(input);
  });

  it("leaves inline code spans untouched", () => {
    expect(cleanAiResponseText("Run `pip install **not-bold**` now.")).toBe(
      "Run `pip install **not-bold**` now.",
    );
  });

  it("does not corrupt a spaced multiplication/exponentiation expression outside code", () => {
    // Deliberately NOT wrapped in backticks by the model — single '*' pairs are
    // never stripped (too ambiguous with math), only '**' bold pairs are, and
    // bold stripping requires two *consecutive* asterisks forming a pair, which
    // a lone operator doesn't have.
    expect(cleanAiResponseText("The result of 2 * 3 is 6.")).toBe("The result of 2 * 3 is 6.");
  });

  it("preserves a URL exactly, including underscores and query strings", () => {
    const input = "See https://example.com/foo_bar?x=1&y=2 for details.";
    expect(cleanAiResponseText(input)).toBe(input);
  });

  it("preserves a URL even when markdown-like characters surround it in prose", () => {
    const input = "**Docs:** https://example.com/a_b_c";
    expect(cleanAiResponseText(input)).toBe("Docs: https://example.com/a_b_c");
  });

  it("preserves JSON-like inline code exactly (no header/bold mangling inside it)", () => {
    const input = 'Config: `{"key": "**not bold**", "# not heading": 1}`';
    expect(cleanAiResponseText(input)).toBe(input);
  });

  it("handles a response combining prose, a heading, a list, and a code block without cross-contamination", () => {
    const input =
      "## Steps\n\nFirst, **install** the package:\n\n```bash\npip install foo\n```\n\n* Then run it\n* Then check logs\n\n---\n\nSee https://example.com/docs for more.";
    const expected =
      "Steps\n\nFirst, install the package:\n\n```bash\npip install foo\n```\n\n- Then run it\n- Then check logs\n\nSee https://example.com/docs for more.";
    expect(cleanAiResponseText(input)).toBe(expected);
  });
});

describe("cleanAiResponseText — edge cases", () => {
  it("returns an empty string unchanged", () => {
    expect(cleanAiResponseText("")).toBe("");
  });

  it("leaves plain prose with no markdown completely unchanged (aside from outer trim)", () => {
    const input = "Just a normal sentence with no special formatting at all.";
    expect(cleanAiResponseText(input)).toBe(input);
  });
});
