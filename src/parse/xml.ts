/**
 * Minimal XML parser sufficient for FCPXML: elements, attributes, text,
 * comments, CDATA, processing instructions. No external dependencies.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: Map<string, string>;
  readonly children: XmlElement[];
  text: string;
}

export function attr(el: XmlElement, name: string): string | null {
  return el.attributes.get(name) ?? null;
}

export function children(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

export function firstChild(el: XmlElement, name: string): XmlElement | null {
  return el.children.find((c) => c.name === name) ?? null;
}

export function parseXml(text: string): XmlElement {
  let pos = 0;
  const len = text.length;

  function error(msg: string): never {
    throw new Error(`XML parse error at offset ${pos}: ${msg}`);
  }

  function skipMisc(): void {
    for (;;) {
      while (pos < len && /\s/.test(text[pos])) pos++;
      if (text.startsWith("<?", pos)) {
        const end = text.indexOf("?>", pos);
        if (end < 0) error("unterminated processing instruction");
        pos = end + 2;
      } else if (text.startsWith("<!--", pos)) {
        const end = text.indexOf("-->", pos);
        if (end < 0) error("unterminated comment");
        pos = end + 3;
      } else if (text.startsWith("<!DOCTYPE", pos) || text.startsWith("<!doctype", pos)) {
        const end = text.indexOf(">", pos);
        if (end < 0) error("unterminated DOCTYPE");
        pos = end + 1;
      } else {
        return;
      }
    }
  }

  function parseName(): string {
    const m = /^[A-Za-z_][\w.:-]*/.exec(text.slice(pos));
    if (!m) error("expected element name");
    pos += m[0].length;
    return m[0];
  }

  function decodeEntities(s: string): string {
    return s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, "&");
  }

  function parseElement(): XmlElement {
    if (text[pos] !== "<") error("expected '<'");
    pos++;
    const name = parseName();
    const attributes = new Map<string, string>();
    for (;;) {
      while (pos < len && /\s/.test(text[pos])) pos++;
      if (text.startsWith("/>", pos)) {
        pos += 2;
        return { name, attributes, children: [], text: "" };
      }
      if (text[pos] === ">") {
        pos++;
        break;
      }
      const attrName = parseName();
      while (pos < len && /\s/.test(text[pos])) pos++;
      if (text[pos] !== "=") error(`expected '=' after attribute ${attrName}`);
      pos++;
      while (pos < len && /\s/.test(text[pos])) pos++;
      const quote = text[pos];
      if (quote !== '"' && quote !== "'") error("expected quoted attribute value");
      const end = text.indexOf(quote, pos + 1);
      if (end < 0) error("unterminated attribute value");
      attributes.set(attrName, decodeEntities(text.slice(pos + 1, end)));
      pos = end + 1;
    }
    const kids: XmlElement[] = [];
    let body = "";
    for (;;) {
      if (pos >= len) error(`unterminated element <${name}>`);
      if (text.startsWith(`</${name}`, pos)) {
        const end = text.indexOf(">", pos);
        if (end < 0) error("unterminated closing tag");
        pos = end + 1;
        return { name, attributes, children: kids, text: decodeEntities(body.trim()) };
      }
      if (text.startsWith("<!--", pos)) {
        const end = text.indexOf("-->", pos);
        if (end < 0) error("unterminated comment");
        pos = end + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", pos)) {
        const end = text.indexOf("]]>", pos);
        if (end < 0) error("unterminated CDATA");
        body += text.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      if (text[pos] === "<") {
        kids.push(parseElement());
        continue;
      }
      const next = text.indexOf("<", pos);
      body += text.slice(pos, next < 0 ? len : next);
      pos = next < 0 ? len : next;
    }
  }

  skipMisc();
  const root = parseElement();
  return root;
}
