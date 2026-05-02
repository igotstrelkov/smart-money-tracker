// Configuration loading and validation.
// Reads .env for Telegram credentials and slate.json for wallet list.
// Throws clear errors if anything is missing or malformed.

import { readFileSync } from "node:fs";
import "dotenv/config";

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
}

export interface SlateEntry {
  address: string;
  name: string;
  rationale: string;
}

export function loadConfig(): Config {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (!telegramBotToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  }
  if (!telegramChatId) {
    throw new Error("Missing TELEGRAM_CHAT_ID in .env");
  }

  return { telegramBotToken, telegramChatId };
}

export function loadSlate(path: string = "slate.json"): SlateEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`Cannot read slate file: ${path}`);
  }

  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in slate file: ${path}`);
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Slate file must be a non-empty array: ${path}`);
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Record<string, unknown>;
    if (!e.address || typeof e.address !== "string") {
      throw new Error(`Slate entry ${i}: missing or invalid "address"`);
    }
    if (!e.name || typeof e.name !== "string") {
      throw new Error(`Slate entry ${i}: missing or invalid "name"`);
    }
    if (!e.rationale || typeof e.rationale !== "string") {
      throw new Error(`Slate entry ${i}: missing or invalid "rationale"`);
    }
  }

  return entries as SlateEntry[];
}
