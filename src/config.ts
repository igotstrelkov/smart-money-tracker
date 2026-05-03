// Configuration loading and validation.
// Reads .env for Telegram credentials and slate.json for wallet list.
// Throws clear errors if anything is missing or malformed.

import { readFileSync } from "node:fs";
import "dotenv/config";

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  shadowSizeUsd: number;
  slippageAlertMaxCents: number;
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

  const shadowSizeUsd = parseFloat(process.env.SHADOW_SIZE_USD || "10");

  const rawSlippage = process.env.SLIPPAGE_ALERT_MAX_CENTS;
  let slippageAlertMaxCents = 3;
  if (rawSlippage !== undefined && rawSlippage !== "") {
    const parsed = parseFloat(rawSlippage);
    if (Number.isFinite(parsed) && parsed >= 0) {
      slippageAlertMaxCents = parsed;
    } else {
      console.warn(
        `Invalid SLIPPAGE_ALERT_MAX_CENTS="${rawSlippage}", defaulting to 3`,
      );
    }
  }

  return {
    telegramBotToken,
    telegramChatId,
    shadowSizeUsd,
    slippageAlertMaxCents,
  };
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
