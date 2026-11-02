function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|quot|amp|apos|lt|gt|nbsp);/gi, (entity, key: string) => {
    if (key.startsWith("#")) {
      const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ({ quot: '"', amp: "&", apos: "'", lt: "<", gt: ">", nbsp: " " } as Record<string, string>)[key.toLowerCase()] ?? entity;
  });
}

export function parseInstagramPreview(html: string) {
  const tags: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) attrs[match[1].toLowerCase()] = decode(match[3]);
    const key = attrs.property ?? attrs.name;
    if (key && attrs.content) tags[key.toLowerCase()] = attrs.content;
  }
  const image = tags["twitter:image"] ?? tags["og:image"];
  const title = tags["og:title"];
  const description = tags.description ?? "";
  const author = tags["twitter:title"]?.match(/^(.*?)\s*\(@([^\s)]+)\)/);
  const caption = (title?.match(/on Instagram:\s*"([\s\S]*)"/)?.[1] ?? description.match(/:\s*"([\s\S]*)"/)?.[1])?.trim().slice(0, 300);
  const date = description.match(/\bon ([A-Za-z]+) (\d{1,2}), (\d{4}):/);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = date ? months.indexOf(date[1]) + 1 : 0;
  const postedOn = date && month ? `${date[3]}-${String(month).padStart(2, "0")}-${date[2].padStart(2, "0")}` : undefined;
  if (!image && !caption && !author) return null;
  return { authorName: author?.[1].trim() ?? title?.split(" on Instagram:")[0], handle: author?.[2], caption, postedOn, image };
}
