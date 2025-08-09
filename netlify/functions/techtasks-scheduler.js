// netlify/functions/techtasks-scheduler.js
// ESM module

import fetch from "node-fetch";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { getStore as _getStore } from "@netlify/blobs";
import { setTimeout as sleep } from "node:timers/promises";

// ==== ENV ====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID");
}

const LIST_URL = "https://astanahub.com/ru/tech_task/";

// Blobs manual config
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
const NETLIFY_ACCESS_TOKEN = process.env.NETLIFY_ACCESS_TOKEN;
if (!NETLIFY_SITE_ID || !NETLIFY_ACCESS_TOKEN) {
  throw new Error("Missing NETLIFY_SITE_ID or NETLIFY_ACCESS_TOKEN for Netlify Blobs manual config");
}
const STORE_NAME = "techtasks-seen"; // your blob store name

// Scrolling controls
const MAX_SCROLL_ROUNDS = parseInt(process.env.MAX_SCROLL_ROUNDS || "60", 10);
const WAIT_BETWEEN_SCROLL_MS = parseInt(process.env.WAIT_BETWEEN_SCROLL_MS || "1200", 10);
const IDLE_AFTER_NO_GROWTH_ROUNDS = parseInt(process.env.IDLE_AFTER_NO_GROWTH_ROUNDS || "3", 10);
const ORDER_NEWEST_FIRST = (process.env.ORDER_NEWEST_FIRST || "true") === "true";

// ===== Helpers =====
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseDdMmYyToUTC(dateStr) {
  if (!dateStr) return null;
  const clean = dateStr.replace(/^\s*до\s*/i, "").trim(); // drop "до" + spaces
  const m = clean.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2]; let y = +m[3];
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  y += y < 70 ? 2000 : 1900;
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
}

// Start of today in Asia/Almaty (UTC+5), expressed in UTC
function todayStartUTC_Almaty() {
  const now = new Date();
  const offsetMs = 5 * 60 * 60 * 1000;
  const almatyNow = new Date(now.getTime() + offsetMs);
  const y = almatyNow.getUTCFullYear();
  const m = almatyNow.getUTCMonth();
  const d = almatyNow.getUTCDate();
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetMs);
}
function isExpiredByAlmaty(deadlineUTC) {
  return deadlineUTC < todayStartUTC_Almaty();
}

function formatForTelegram(item) {
  const lines = [];
  const add = (label, val) => val && lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(String(val).trim())}`);
  add("Заголовок", item.title);
  add("Описание", item.description);
  add("Клиент", item.client);
  add("Дедлайн", item.deadline);
  add("Область задачи", item.taskArea);
  add("Подано заявок", item.applications);
  return lines.join("\n");
}

async function postToTelegram(message, link) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHANNEL_ID,
      text: `${message}\n\nСсылка: ${link}`,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram error: ${res.status} ${t}`);
  }
}

// ===== Netlify Blobs (manual config) =====
function getStore() {
  // Manual siteID/token so this works even without auto-injection
  return _getStore({
    name: STORE_NAME,
    siteID: NETLIFY_SITE_ID,
    token: NETLIFY_ACCESS_TOKEN,
  });
}

async function readSeenSet() {
  const store = getStore();
  const json = await store.get("seen.json", { type: "json" }); // null if missing
  const arr = Array.isArray(json) ? json : [];
  return new Set(arr);
}

async function writeSeenSet(seenSet) {
  const store = getStore();
  await store.set("seen.json", JSON.stringify([...seenSet]), {
    contentType: "application/json",
  });
}

// ===== Scrolling & Extraction =====

/**
 * Scrolls and stops when:
 *  - first EXPIRED/MALFORMED deadline is encountered in order, OR
 *  - content stops growing for a few rounds, OR
 *  - MAX_SCROLL_ROUNDS reached.
 * Returns the index (count) of non-expired head to keep (if ORDER_NEWEST_FIRST), else null.
 */
async function scrollUntilExpiredOrEnd(page) {
  let lastCount = 0;
  let noGrowthRounds = 0;
  let lastExamined = 0;
  let stopAtCount = null;

  for (let i = 0; i < MAX_SCROLL_ROUNDS; i++) {
    const count = await page.$$eval(".techtask-card", els => els.length);
    noGrowthRounds = count <= lastCount ? (noGrowthRounds + 1) : 0;
    lastCount = count;

    // Examine only new portion in display order
    const res = await page.evaluate(({ start, newestFirst }) => {
      const base = "https://astanahub.com";
      const cards = Array.from(document.querySelectorAll(".techtask-card"));
      const ordered = newestFirst ? cards : cards.slice().reverse();
      const slice = ordered.slice(start);
      return slice.map(card => {
        // deadline: first tech-list-item -> second p -> b
        const right = card.querySelector(".right");
        let deadlineText = "";
        if (right) {
          const techItems = right.querySelectorAll("div.tech-list-item");
          if (techItems[0]) {
            const ps = techItems[0].querySelectorAll("p");
            deadlineText = ps[1]?.querySelector("b")?.textContent?.trim() || "";
          }
        }
        // also return link if you want to debug
        const linkEl = card.querySelector("a[href]");
        let link = linkEl ? linkEl.getAttribute("href") : "";
        if (link && link.startsWith("/")) link = base + link;
        return { deadlineText, link };
      });
    }, { start: lastExamined, newestFirst: ORDER_NEWEST_FIRST });

    // Stop at first expired/malformed deadline
    let foundStop = false;
    for (let idx = 0; idx < res.length; idx++) {
      const d = parseDdMmYyToUTC(res[idx].deadlineText);
      const expiredOrInvalid = !d || isExpiredByAlmaty(d);
      if (expiredOrInvalid) {
        const absoluteIndex = lastExamined + idx;
        stopAtCount = ORDER_NEWEST_FIRST ? absoluteIndex : null;
        foundStop = true;
        break;
      }
    }
    lastExamined += res.length;

    if (foundStop) break;
    if (noGrowthRounds >= IDLE_AFTER_NO_GROWTH_ROUNDS) break;

    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
    await sleep(WAIT_BETWEEN_SCROLL_MS);
  }

  return stopAtCount;
}

async function extractAllItems(page) {
  return page.evaluate(() => {
    const base = "https://astanahub.com";
    const cards = Array.from(document.querySelectorAll(".techtask-card"));

    console.log('FOUND CARDS:', cards);
    console.log('FOUND CARDS LENGTH:', cards.length);

    return cards.map(card => {
      const left = card.querySelector(".left");
      const right = card.querySelector(".right");

      const title = left?.querySelector("h2")?.textContent?.trim() || "";
      const description = left?.querySelector("p")?.textContent?.trim() || "";

      let link = card.getAttribute("href") || "";
      if (link && link.startsWith("/")) link = base + link;

      const client = right?.querySelector("div.card-avatar-block div.card-author h4")?.textContent?.trim() || "";

      const techItems = right ? Array.from(right.querySelectorAll("div.tech-list-item")) : [];

      // FIRST tech-item inside .right (ignoring .card-avatar-block)
      let deadline = "";
      const firstTech = right?.querySelector(".tech-list-item");
      if (firstTech) {
        const b = firstTech.querySelector("b");
        deadline = (b?.textContent || firstTech.textContent || "").trim();
      }

      let taskArea = "";
      if (techItems[1]) {
        taskArea = techItems[1]?.querySelector("span")?.textContent?.trim() || "";
      }

      let applications = "";
      if (techItems[2]) {
        const ps2 = techItems[2].querySelectorAll("p");
        applications = ps2[1]?.textContent?.trim() || "";
      }

      return { title, description, client, deadline, taskArea, applications, link };
    });
  });
}

// ===== Handler =====
export async function handler() {
  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 2000 },
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });

    const stopAtCount = await scrollUntilExpiredOrEnd(page);
    let items = await extractAllItems(page);
    if (ORDER_NEWEST_FIRST && stopAtCount !== null) {
      items = items.slice(0, stopAtCount);
    }

    console.log('SCRAPPED ITEMS:', items);
    console.log('SCRAPPED ITEMS LENGTH:', items.length);

    const seen = await readSeenSet();

    const mapDateItems = items.map(x => ({ ...x, _deadlineUTC: parseDdMmYyToUTC(x.deadline) }));

    console.log('MAP DATE ITEMS:', mapDateItems);

    const correctDateItems = mapDateItems.map(x => x._deadlineUTC);

    console.log('CORRECT DATE ITEMS:', correctDateItems);

    const isExpiredByAlmatyItems =  correctDateItems.filter(x => !isExpiredByAlmaty(x._deadlineUTC));

    console.log('IS EXPIRED BY ALMATY ITEMS:', isExpiredByAlmatyItems);

    // Enforce deadline required + skip expired + dedupe
    const filtered = items
      .filter(x => x.link && !seen.has(x.link))
      .map(x => ({ ...x, _deadlineUTC: parseDdMmYyToUTC(x.deadline) }))
      .filter(x => x._deadlineUTC)                   // require valid deadline
      .filter(x => !isExpiredByAlmaty(x._deadlineUTC)); // keep only non-expired

    if (filtered.length === 0) {
      await browser.close();
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: "No new, valid (non-expired) tasks." }) };
    }

    let posted = 0;
    for (const item of filtered) {
      const msg = formatForTelegram(item);
      try {
        await postToTelegram(msg, item.link);
        posted++;
        seen.add(item.link);
        await sleep(800);
      } catch (e) {
        console.error("Failed to post:", e.message);
      }
    }

    await writeSeenSet(seen);

    await browser.close();
    return { statusCode: 200, body: JSON.stringify({ ok: true, posted }) };
  } catch (e) {
    console.error(e);
    try { await browser.close(); } catch {}
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
}