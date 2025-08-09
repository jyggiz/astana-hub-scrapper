import fetch from "node-fetch";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { getStore } from "@netlify/blobs";

// === ENV ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID");
}

// === CONFIG ===
const LIST_URL = "https://astanahub.com/ru/tech_task/";
const MAX_SCROLL_ROUNDS = parseInt(process.env.MAX_SCROLL_ROUNDS || "30", 10);
const WAIT_BETWEEN_SCROLL_MS = parseInt(process.env.WAIT_BETWEEN_SCROLL_MS || "1500", 10);
const IDLE_AFTER_NO_GROWTH_ROUNDS = parseInt(process.env.IDLE_AFTER_NO_GROWTH_ROUNDS || "3", 10);

// === DEDUPE via Netlify Blobs ===
// We store a JSON set of links under key "seen.json"
const STORE_NAME = "techtasks-seen"; // creates/uses a Blob store with this name
const SEEN_KEY = "seen.json";

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatForTelegram(item) {
  const lines = [];
  const add = (label, val) => {
    if (val && String(val).trim()) {
      lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(String(val).trim())}`);
    }
  };
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

async function readSeenSet() {
  const store = getStore(STORE_NAME);
  const blob = await store.get(SEEN_KEY, { type: "json" });
  const arr = Array.isArray(blob) ? blob : [];
  return new Set(arr);
}

async function writeSeenSet(seenSet) {
  const store = getStore(STORE_NAME);
  await store.set(SEEN_KEY, JSON.stringify([...seenSet]), {
    contentType: "application/json",
  });
}

async function scrapeAll(page) {
  await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });

  let noGrowthRounds = 0;
  let lastCount = 0;

  for (let i = 0; i < MAX_SCROLL_ROUNDS; i++) {
    const count = await page.$$eval(".techtask-card", els => els.length);

    if (count <= lastCount) noGrowthRounds++;
    else noGrowthRounds = 0;
    lastCount = count;

    if (noGrowthRounds >= IDLE_AFTER_NO_GROWTH_ROUNDS) break;

    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
    await page.waitForTimeout(WAIT_BETWEEN_SCROLL_MS);
  }

  const items = await page.evaluate(() => {
    const base = "https://astanahub.com";
    const cards = Array.from(document.querySelectorAll(".techtask-card"));
    return cards.map(card => {
      const left = card.querySelector(".left");
      const right = card.querySelector(".right");

      const title = left?.querySelector("h2")?.textContent?.trim() || "";
      const description = left?.querySelector("p")?.textContent?.trim() || "";

      const linkEl = card.querySelector("a[href]");
      let link = linkEl ? linkEl.getAttribute("href") : "";
      if (link && link.startsWith("/")) link = base + link;

      const client = right?.querySelector("div.card-avatar-block div.card-author h4")?.textContent?.trim() || "";

      const techItems = right ? Array.from(right.querySelectorAll("div.tech-list-item")) : [];

      let deadline = "";
      if (techItems[0]) {
        const ps = techItems[0].querySelectorAll("p");
        deadline = ps[1]?.querySelector("b")?.textContent?.trim() || "";
      }

      let taskArea = "";
      if (techItems[1]) {
        taskArea = techItems[1]?.querySelector("span b")?.textContent?.trim() || "";
      }

      let applications = "";
      if (techItems[2]) {
        const ps2 = techItems[2].querySelectorAll("p");
        applications = ps2[1]?.textContent?.trim() || "";
      }

      return { title, description, client, deadline, taskArea, applications, link };
    });
  });

  return items;
}

export async function handler() {
  // Launch headless Chromium for serverless
  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 2000 },
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();

    const all = await scrapeAll(page);
    const seen = await readSeenSet();

    // Dedup by link
    const fresh = all.filter(x => x.link && !seen.has(x.link));

    if (fresh.length === 0) {
      await browser.close();
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, message: "No new tasks." })
      };
    }

    for (const item of fresh) {
      const msg = formatForTelegram(item);
      try {
        await postToTelegram(msg, item.link);
        seen.add(item.link);
        await new Promise(r => setTimeout(r, 800)); // polite pacing
      } catch (err) {
        console.error("Failed to post:", err.message);
      }
    }

    await writeSeenSet(seen);

    await browser.close();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, posted: fresh.length })
    };
  } catch (e) {
    console.error(e);
    try { await browser.close(); } catch {}
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
}