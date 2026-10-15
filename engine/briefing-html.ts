export const MAX_BRIEFING_HTML_BYTES = 5 * 1024 * 1024;

export function extractBriefingHtml(output: string) {
  const doctype = output.search(/<!doctype\s+html\b/i);
  const htmlStart = output.search(/<html\b/i);
  const start = doctype >= 0 ? doctype : htmlStart;
  const end = output.toLowerCase().lastIndexOf("</html>");
  if (start < 0 || end < start)
    throw Error("Briefing model did not return a complete HTML document");
  const html = output.slice(start, end + "</html>".length).trim();
  if (Buffer.byteLength(html) > MAX_BRIEFING_HTML_BYTES)
    throw Error("Briefing HTML exceeds the 5 MiB preview limit");
  if (!/<head\b/i.test(html) || !/<body\b/i.test(html))
    throw Error("Briefing HTML requires head and body elements");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(html))
    throw Error("Briefing HTML contains invalid control characters");
  if (/<\s*(?:script|iframe|object|embed|base|form)\b/i.test(html))
    throw Error("Briefing HTML contains an active or embedding element");
  if (/<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html))
    throw Error("Briefing HTML cannot redirect the preview");
  if (/<\s*link\b/i.test(html))
    throw Error("Briefing HTML cannot load external stylesheets");
  if (
    /\son[a-z]+\s*=/i.test(html) ||
    /(?:href|src)\s*=\s*["']\s*javascript:/i.test(html)
  )
    throw Error(
      "Briefing HTML cannot contain executable event handlers or URLs",
    );
  if (
    /<\s*(?:img|image|use|source|video|audio)\b[^>]*\b(?:src|srcset|href|poster)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(
      html,
    )
  )
    throw Error("Briefing HTML cannot load remote media");
  if (
    /url\(\s*["']?\s*(?:https?:|\/\/)/i.test(html) ||
    /@import\s+(?:url\()?\s*["']?\s*(?:https?:|\/\/)/i.test(html)
  )
    throw Error("Briefing HTML cannot load remote CSS resources");
  return html;
}
