import axios from 'axios';
import fs from 'fs';
import path from 'path';
import aiService from './ai_service';
import db from './database';
import { send as sendSSE } from './sse_logger';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, HTTPResponse } from 'puppeteer';

puppeteer.use(StealthPlugin());

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const PROJECT_ROOT = __dirname.endsWith(`${path.sep}dist`) ? path.join(__dirname, '..') : __dirname;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleepRandom(minMs = 2000, maxMs = 5000) {
  return sleep(randomInt(minMs, maxMs));
}

function slugify(text: string) {
  return String(text || 'image')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/-{2,}/g, '-')
    .substring(0, 80);
}

async function downloadImage(imageUrl: string | null, title: string) {
  if (!imageUrl) return null;
  try {
    new URL(imageUrl);
  } catch {
    console.warn(`⚠️ Geçersiz görsel URL'si, atlanıyor: ${imageUrl}`);
    return null;
  }

  try {
    const rawExt = path.extname(new URL(imageUrl).pathname).split('?')[0];
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const finalExt = allowedExts.includes(rawExt.toLowerCase()) ? rawExt.toLowerCase() : '.jpg';

    const slug = slugify(title);
    const filename = `${slug}-${Date.now()}${finalExt}`;
    const savePath = path.join(PROJECT_ROOT, 'public', 'uploads', 'games', filename);

    const response = await axios.get(imageUrl, {
      responseType: 'stream',
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://www.google.com/',
      }
    });

    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(savePath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log(`🖼️  Görsel kaydedildi: ${filename}`);
    return `/uploads/games/${filename}`;
  } catch (err: unknown) {
    console.warn(`⚠️ Görsel indirme başarısız (${imageUrl}): ${getErrorMessage(err)}`);
    return null;
  }
}

const CONTENT_SELECTORS = [
  '.article-content',
  'section.article-page',
  'div.article-body',
  '[itemprop="articleBody"]'
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const EXTRA_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
  Connection: 'keep-alive',
  'Referer': 'https://www.google.com/',
  'Upgrade-Insecure-Requests': '1'
};

const MIN_CONTENT_LENGTH = 500;

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });
}

async function preparePage(browser: Browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders(EXTRA_HEADERS);
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}

interface ScrapedArticle {
  title: string;
  content: string;
  mainImage: string | null;
  image_url: string | null;
}

class ScraperService {
  getAbsoluteUrl(base: string, href: string) {
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  }

  async scrapeLatestFromHomepage(homeUrl: string) {
    console.log(`\n🏠 Ana sayfa taranıyor: ${homeUrl}`);
    sendSSE(`Ana sayfa taranıyor: ${homeUrl}`);

    let browser: Browser | null = null;

    try {
      const baseOrigin = new URL(homeUrl).origin;
      const newsUrl = homeUrl.includes('/news') ? homeUrl : `${baseOrigin}/news`;

      console.log(`📰 Haber listesi sayfası: ${newsUrl}`);
      sendSSE(`Haber listesi sayfası: ${newsUrl}`);

      browser = await launchBrowser();
      if (!browser) {
        throw new Error('Browser failed to launch');
      }
      const page = await preparePage(browser);

      try {
        await page.goto(newsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (navErr: unknown) {
        const message = getErrorMessage(navErr);
        console.warn(`⚠️ /news navigation hatası: ${message}. homeUrl deneniyor...`);
        sendSSE(`/news navigation hatası: ${message}`);
        try {
          await page.evaluate(() => {
            const win = window as unknown as { stop?: () => void };
            if (win.stop) win.stop();
          });
        } catch {
          // ignore
        }
        await page.goto(homeUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      }

      const articleLinks: string[] = await page.evaluate((origin: string) => {
        const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        const seen = new Set<string>();
        const results: string[] = [];

        for (const anchor of anchors) {
          try {
            const abs = new URL(anchor.href, origin).toString();
            if (abs.includes('/articles/') && !seen.has(abs)) {
              seen.add(abs);
              results.push(abs);
            }
          } catch {
            // ignore
          }
        }
        return results;
      }, baseOrigin);

      console.log(`🔗 Bulunan /articles/ linkleri: ${articleLinks.length} adet`);
      sendSSE(`Bulunan /articles/ linkleri: ${articleLinks.length}`);

      if (articleLinks.length === 0) {
        throw new Error(`"${newsUrl}" sayfasında /articles/ içeren hiçbir haber linki bulunamadı.`);
      }

      await browser.close();
      browser = null;

      const targets = articleLinks.slice(0, 2);
      console.log(`🎯 İşlenecek linkler:\n  ${targets.join('\n  ')}`);
      sendSSE(`İşlenecek linkler: ${JSON.stringify(targets)}`);

      const results: { title: string; source: string; image_url: string | null }[] = [];

      for (const articleUrl of targets) {
        try {
          console.log(`\n📄 Makale işleniyor: ${articleUrl}`);
          sendSSE(`Makale işleniyor: ${articleUrl}`);

          const article = await this.scrapeArticleDetail(articleUrl);

          const prompt =
            `Aşağıdaki haber metnini kullanarak profesyonel, SEO uyumlu bir blog yazısı oluştur. ` +
            `İçerik HTML formatında olsun, giriş-gelişme-sonuç yapısında yaz. ` +
            `Başlık: ${article.title}\n\nİÇERİK:\n${article.content}`;

          sendSSE(`AI analiz başlıyor: ${article.title}`);
          const aiDraft = await aiService.generateWithRetry(prompt);
          sendSSE(`AI analiz tamamlandı: ${article.title}`);

          try {
            await db.runAsync(
              'INSERT INTO posts (title, content, is_published, quality_score) VALUES (?, ?, ?, ?)',
              [article.title || 'Başlıksız', aiDraft, 0, 0]
            );
            console.log(`✅ Taslak kaydedildi: "${article.title}"`);
            sendSSE(`Taslak kaydedildi: ${article.title}`);
          } catch (dbErr: unknown) {
            const message = getErrorMessage(dbErr);
            console.error('❌ DB kayıt hatası:', message);
            sendSSE(`DB kayıt hatası: ${message}`);
          }

          results.push({ title: article.title, source: articleUrl, image_url: article.image_url });
        } catch (articleErr: unknown) {
          const message = getErrorMessage(articleErr);
          console.error(`❌ Makale işleme hatası (${articleUrl}):`, message);
          sendSSE(`Makale işleme hatası: ${message}`);
        }

        await sleepRandom(2000, 4000);
      }

      if (results.length === 0) {
        throw new Error('Hiçbir makale başarıyla işlenemedi.');
      }

      return {
        title: results[0].title,
        source: results[0].source,
        image_url: results[0].image_url,
        processed: results.length
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('❌ scrapeLatestFromHomepage hata:', message);
      sendSSE(`Ana sayfa tarama hatası: ${message}`);
      throw error;
    } finally {
      if (browser) {
        try { await browser.close(); } catch {
          // ignore close error
        }
      }
    }
  }

  async scrapeArticleDetail(url: string): Promise<ScrapedArticle> {
    console.log(`🔎 Detay sayfasına giriliyor: ${url}`);
    sendSSE(`Detay sayfasına giriliyor: ${url}`);

    let browser: Browser | null = null;

    try {
      await sleepRandom(1000, 2500);

      browser = await launchBrowser();
      if (!browser) {
        throw new Error('Browser failed to launch');
      }
      const page = await preparePage(browser);

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (navErr: unknown) {
        const message = getErrorMessage(navErr);
        console.warn(`⚠️ Navigation hatası: ${message}, içerik yine de alınmaya çalışılıyor...`);
        sendSSE(`Navigation hatası: ${message}`);
        try {
          await page.evaluate(() => {
            const win = window as unknown as { stop?: () => void };
            if (win.stop) win.stop();
          });
        } catch {
          // ignore
        }
      }

      console.log('⏳ 3 saniye bekleniyor (lazy-load içerikler için)...');
      await sleep(3000);

      const pageData = await page.evaluate((selectors: string[]) => {
        const titleEl =
          document.querySelector('h1') ||
          document.querySelector('[itemprop="headline"]') ||
          document.querySelector('title');
        const title = titleEl ? (titleEl.textContent || '').trim() : document.title.trim();

        const ogImageEl = document.querySelector('meta[property="og:image"]');
        const mainImage = ogImageEl ? ogImageEl.getAttribute('content') : null;

        let content = '';
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            el.querySelectorAll(
              'script, style, aside, nav, .ad, .ads, .advertisement, .social-share, .newsletter, .related-articles, [aria-hidden="true"]'
            ).forEach((n) => n.remove());
            const text = (el.textContent || '').trim();
            if (text.length > 100) {
              content = text;
              break;
            }
          }
        }

        if (!content || content.length < 100) {
          const paragraphs = Array.from(document.querySelectorAll('article p, main p, .content p, section p, p'))
            .map((p) => (p.textContent || '').trim())
            .filter((t) => t.length > 30);
          content = paragraphs.join('\n\n');
        }

        return { title, mainImage, content };
      }, CONTENT_SELECTORS);

      const charCount = pageData.content ? pageData.content.length : 0;
      if (charCount < MIN_CONTENT_LENGTH) {
        throw new Error(`İçerik Yetersiz: Çekilen metin ${charCount} karakter (minimum ${MIN_CONTENT_LENGTH} gerekli). URL: ${url}`);
      }

      const image_url = await downloadImage(pageData.mainImage, pageData.title);

      console.log(`✅ İçerik başarıyla çekildi: "${pageData.title}" (${charCount} karakter, görsel: ${image_url || 'yok'})`);
      sendSSE(`İçerik alındı: ${pageData.title} (${charCount} karakter)`);

      return {
        title: pageData.title,
        content: pageData.content.substring(0, 10000),
        mainImage: pageData.mainImage,
        image_url
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error(`❌ scrapeArticleDetail hata (${url}):`, message);
      sendSSE(`İçerik çekme hatası: ${message}`);
      throw error;
    } finally {
      if (browser) {
        try { await browser.close(); } catch {
          // ignore
        }
        console.log('🧹 Puppeteer instance kapatıldı.');
      }
    }
  }

  async scrapeFullText(url: string) {
    console.log(`📄 scrapeFullText çağrıldı (yeni motora yönlendiriliyor): ${url}`);
    return this.scrapeArticleDetail(url);
  }

  async scrapeAndTestGame(url: string) {
    console.log(`🎮 Oyun test ediliyor: ${url}`);
    let browser: Browser | null = null;

    try {
      await sleepRandom(2000, 5000);

      browser = await launchBrowser();
      if (!browser) {
        throw new Error('Browser failed to launch');
      }
      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setExtraHTTPHeaders(EXTRA_HEADERS);

      let redirectCount = 0;
      page.on('response', (response: HTTPResponse) => {
        const status = response.status();
        if (status >= 300 && status <= 399) redirectCount++;
      });

      await page.setViewport({ width: 1280, height: 720 });
      try {
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 60000,
          referer: 'https://www.google.com/'
        });
      } catch (navErr: unknown) {
        const message = getErrorMessage(navErr);
        console.warn(`Navigation error for ${url}:`, message);
        try {
          await page.evaluate(() => {
            const win = window as unknown as { stop?: () => void };
            if (win.stop) win.stop();
          });
        } catch {
          // ignore
        }
      }

      if (redirectCount > 5) {
        console.warn('⚠️ Çok fazla yönlendirme tespit edildi.');
        try {
          await page.evaluate(() => {
            const win = window as unknown as { stop?: () => void };
            if (win.stop) win.stop();
          });
        } catch {
          // ignore
        }
      }

      const embedData = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe')) as HTMLIFrameElement[];
        const validIframe = iframes.find((f) => {
          const width = parseInt(f.width || '0', 10);
          const height = parseInt(f.height || '0', 10);
          return width > 200 && height > 200 && !!f.src;
        });
        if (validIframe) {
          return { type: 'iframe', code: validIframe.outerHTML, src: validIframe.src };
        }
        const canvas = document.querySelector('canvas');
        if (canvas) {
          return { type: 'canvas', code: 'HTML5 Container detected', src: window.location.href };
        }
        return null;
      });

      if (!embedData) {
        throw new Error('Sayfada geçerli bir oyun (iframe/canvas) bulunamadı.');
      }

      await page.setViewport({ width: 375, height: 667, isMobile: true });
      await page.reload({ waitUntil: 'networkidle2' });

      const isOverflowing = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

      if (isOverflowing) {
        console.warn(`⚠️ Oyun mobil görünümde taşıyor: ${url}`);
      }

      return {
        ...embedData,
        title: await page.title(),
        isMobileFriendly: !isOverflowing
      };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error(`❌ Oyun kazıma hatası (${url}):`, message);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
        console.log('🧹 Puppeteer instance kapatıldı.');
      }
    }
  }
}

export default new ScraperService();
