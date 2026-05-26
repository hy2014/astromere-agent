#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const OFFICIAL_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const settingsPath = join(homedir(), ".agent-ui", "model-settings.json");

function fail(message) {
  throw new Error(`[deepseek-pricing] ${message}`);
}

function decodeEntities(input) {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

function normalizeText(html) {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(text) {
  return text.replace(/\s+/g, "");
}

function yuanNumbersAfter(compactText, labels, logicalName) {
  let index = -1;
  let matchedLabel = "";
  for (const label of labels) {
    index = compactText.indexOf(label);
    if (index >= 0) {
      matchedLabel = label;
      break;
    }
  }
  if (index < 0) {
    fail(`cannot find official pricing row for ${logicalName}`);
  }

  const slice = compactText.slice(index + matchedLabel.length, index + matchedLabel.length + 120);
  const values = [...slice.matchAll(/([0-9]+(?:\.[0-9]+)?)元/g)].map((m) => Number(m[1]));
  if (values.length < 2 || !values.slice(0, 2).every(Number.isFinite)) {
    fail(`cannot parse current flash/pro RMB prices for ${logicalName} from slice: ${slice}`);
  }
  return [values[0], values[1]];
}

function priceItem(item, pricePerMTokens) {
  if (!Number.isFinite(pricePerMTokens)) fail(`invalid official RMB price for ${item}`);
  return { item, pricePerMTokens };
}

function modelPricing(model, hit, miss, output) {
  return {
    model,
    items: [
      priceItem("cache_hit_input", hit),
      priceItem("cache_miss_input", miss),
      priceItem("output", output),
    ],
  };
}

async function fetchOfficialPricing() {
  const response = await fetch(OFFICIAL_URL, { headers: { "accept-language": "zh-CN,zh;q=0.9" } });
  if (!response.ok) fail(`HTTP ${response.status} from ${OFFICIAL_URL}`);
  const html = await response.text();
  const text = normalizeText(html);
  const packed = compact(text);

  if (!packed.includes("模型&价格") || !packed.includes("deepseek-v4-flash") || !packed.includes("deepseek-v4-pro")) {
    fail("official pricing page missing expected title/model names after normalization");
  }
  if (!packed.includes("百万tokens")) {
    fail("official pricing page missing expected unit: 百万tokens");
  }

  const [flashHit, proHit] = yuanNumbersAfter(
    packed,
    ["百万tokens输入（缓存命中）", "百万tokens输入(缓存命中)"],
    "cache_hit_input",
  );
  const [flashMiss, proMiss] = yuanNumbersAfter(
    packed,
    ["百万tokens输入（缓存未命中）", "百万tokens输入(缓存未命中)"],
    "cache_miss_input",
  );
  const [flashOutput, proOutput] = yuanNumbersAfter(
    packed,
    ["百万tokens输出"],
    "output",
  );

  return {
    source: "official",
    fetchedAt: new Date().toISOString(),
    url: OFFICIAL_URL,
    currency: "CNY",
    unit: "CNY_PER_1M_TOKENS",
    models: [
      modelPricing("deepseek-v4-flash", flashHit, flashMiss, flashOutput),
      modelPricing("deepseek-chat", flashHit, flashMiss, flashOutput),
      modelPricing("deepseek-reasoner", flashHit, flashMiss, flashOutput),
      modelPricing("deepseek-v4-pro", proHit, proMiss, proOutput),
    ],
  };
}

function readExistingSettings() {
  if (!existsSync(settingsPath)) {
    fail(`${settingsPath} does not exist; refusing to create pricing without existing settings`);
  }
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function writeSettings(settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

const shouldWrite = process.argv.includes("--write");
const pricing = await fetchOfficialPricing();

if (shouldWrite) {
  const settings = readExistingSettings();
  settings.deepseekPricing = pricing;
  writeSettings(settings);
  console.log(`[deepseek-pricing] wrote official RMB pricing to ${settingsPath} from ${OFFICIAL_URL}`);
  console.log(JSON.stringify(pricing, null, 2));
} else {
  console.log(JSON.stringify(pricing, null, 2));
}
