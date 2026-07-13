// config-store.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as cs from "./config-store";
import type { AppConfig } from "./config-store";

const REAL_CONFIG_FILE = join(import.meta.dirname, "..", "data", "config.json");

type Backup = { existed: boolean; content: string };

function backup(): Backup {
  const existed = fs.existsSync(REAL_CONFIG_FILE);
  return { existed, content: existed ? fs.readFileSync(REAL_CONFIG_FILE, "utf-8") : "" };
}

function restore(b: Backup): void {
  // Reset in-memory state to defaults
  cs.saveConfig({ auto_claim_pro: false, monitor_webhook: "", monitor_warn_percent: 80, api_key: "" });
  if (b.existed) {
    fs.writeFileSync(REAL_CONFIG_FILE, b.content, { encoding: "utf-8" });
  } else if (fs.existsSync(REAL_CONFIG_FILE)) {
    fs.writeFileSync(REAL_CONFIG_FILE, "{}", { encoding: "utf-8" });
  }
}

describe("config-store", () => {
  let bak: Backup;

  beforeEach(() => { bak = backup(); cs.saveConfig({ auto_claim_pro: false, monitor_webhook: "", monitor_warn_percent: 80, api_key: "" }); });
  afterEach(() => restore(bak));

  describe("getConfig() after saveConfig()", () => {
    test("returns default values before any save", () => {
      const cfg = cs.getConfig();
      expect(cfg.auto_claim_pro).toBe(false);
      expect(cfg.monitor_warn_percent).toBe(80);
      expect(cfg.monitor_webhook).toBe("");
      expect(cfg.api_key).toBe("");
    });

    test("save partial config, getConfig reflects merged values", () => {
      cs.saveConfig({ auto_claim_pro: true });
      const cfg = cs.getConfig();
      expect(cfg.auto_claim_pro).toBe(true);
      expect(cfg.monitor_warn_percent).toBe(80);
      expect(cfg.monitor_webhook).toBe("");
    });

    test("multiple saveConfig calls accumulate", () => {
      cs.saveConfig({ auto_claim_pro: true });
      cs.saveConfig({ monitor_webhook: "https://hooks.example.com/hook" });
      const cfg = cs.getConfig();
      expect(cfg.auto_claim_pro).toBe(true);
      expect(cfg.monitor_webhook).toBe("https://hooks.example.com/hook");
      expect(cfg.monitor_warn_percent).toBe(80);
    });
  });

  describe("saveConfig() return value", () => {
    test("returns merged config with saved value", () => {
      const result = cs.saveConfig({ auto_claim_pro: true });
      expect(result.auto_claim_pro).toBe(true);
      expect(result.monitor_warn_percent).toBe(80);
    });

    test("returns full AppConfig with defaults preserved", () => {
      const result = cs.saveConfig({ api_key: "my-secret-key" });
      expect(result.api_key).toBe("my-secret-key");
      expect(result.auto_claim_pro).toBe(false);
      expect(result.monitor_webhook).toBe("");
      expect(result.monitor_warn_percent).toBe(80);
    });

    test("subsequent getConfig returns the same values as saveConfig", () => {
      const saved = cs.saveConfig({
        auto_claim_pro: true,
        monitor_webhook: "http://hook.example.com",
      });
      const got = cs.getConfig();
      expect(got).toEqual(saved);
    });
  });

  describe("edge cases", () => {
    test("saving empty object does not crash and preserves state", () => {
      expect(() => cs.saveConfig({})).not.toThrow();
      const cfg = cs.getConfig();
      expect(cfg.auto_claim_pro).toBe(false);
      expect(cfg.monitor_warn_percent).toBe(80);
    });

    test("saving null does not crash (spread of null is {})", () => {
      expect(() => cs.saveConfig(null as unknown as Partial<AppConfig>)).not.toThrow();
      const cfg = cs.getConfig();
      expect(cfg.auto_claim_pro).toBe(false);
    });

    test("saving with undefined fields overwrites the key with undefined", () => {
      cs.saveConfig({ auto_claim_pro: true });
      cs.saveConfig({ auto_claim_pro: undefined as unknown as boolean });
      const cfg = cs.getConfig();
      expect(cfg.auto_claim_pro).toBeUndefined();
    });

    test("saveConfig writes valid JSON to disk", () => {
      cs.saveConfig({ auto_claim_pro: true, monitor_webhook: "http://hook" });
      cs.saveConfig({});
      const cfg = cs.getConfig();
      expect(cfg.auto_claim_pro).toBe(true);
      expect(cfg.monitor_webhook).toBe("http://hook");
    });
  });
});
