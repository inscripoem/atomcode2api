// src/config-store.ts
// Runtime config backed by JSON file. Survives restarts, mutable via API.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dirname, "..");
const CONFIG_DIR = join(PROJECT_DIR, "data");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface AppConfig {
  auto_claim_pro: boolean;
  monitor_webhook: string;
  monitor_warn_percent: number;
  api_key: string;
}

const defaults: AppConfig = {
  auto_claim_pro: false,
  monitor_webhook: "",
  monitor_warn_percent: 80,
  api_key: "",
};

let config: AppConfig = { ...defaults };

export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_FILE)) {
    config = { ...defaults };
    return config;
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    config = { ...defaults, ...JSON.parse(raw) };
    return config;
  } catch {
    config = { ...defaults };
    return config;
  }
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  config = { ...config, ...partial };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

export function getConfig(): AppConfig {
  return { ...config };
}

// Load on import
loadConfig();
