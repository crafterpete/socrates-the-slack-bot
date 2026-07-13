export const MAX_INPUT_LENGTH = 4000;

export function stripBotMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "").trim();
}

export function normalizeUserInput(text: string): string {
  const normalized = text
    .replace(/<(?:https?|mailto):[^|>]*\|([^>]+)>/g, "$1")
    .replace(/<((?:https?|mailto):[^|>]*)>/g, "$1")
    .replace(/<@[^|>]+\|([^>]+)>/g, "@$1")
    .replace(/<@([^|>]+)>/g, "@$1")
    .replace(/<#[^|>]+\|([^>]+)>/g, "#$1")
    .replace(/<#([^|>]+)>/g, "#$1")
    .replace(/<![^|>]*\|([^>]+)>/g, "$1")
    .replace(/<!([^>]+)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= MAX_INPUT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_INPUT_LENGTH)}…`;
}

export function escapeBroadcasts(text: string): string {
  return text
    .replace(/<![^|>]*\|([^>]+)>/g, "$1")
    .replace(/<!([^>]+)>/g, "@$1");
}
