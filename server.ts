import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import { ServerResponse } from 'http';
import session from 'express-session';
import sessionFileStore from 'session-file-store';
import bcrypt from 'bcrypt';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import db from './database';
import aiService from './ai_service';
import cronTasks from './cron_tasks';
import { addClient as addSSEClient } from './sse_logger';
import { EditorSource, Game, LanguageCode, Post, User } from './types';

const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || 'doomsgame-secret-key';
const USE_SECURE_COOKIE = NODE_ENV === 'production';
const useTestSessionStore = NODE_ENV === 'test';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function isValidUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function escapeLike(value: string): string {
  return value.replace(/([%_\\])/g, '\\$1');
}

function validateSourcesPayload(payload: unknown): payload is Array<{ url: string; type: 'news' | 'game' }> {
  if (!Array.isArray(payload)) return false;
  return payload.every((item) => {
    return (
      typeof item === 'object' &&
      item !== null &&
      isNonEmptyString((item as any).url) &&
      isValidUrl((item as any).url) &&
      ((item as any).type === 'news' || (item as any).type === 'game')
    );
  });
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function validationError(res: Response, message = 'Geçersiz veri') {
  return res.status(400).json({ success: false, error: message });
}

function acceptsJson(req: Request) {
  return (
    req.headers.accept?.includes('application/json') ||
    req.get('X-Requested-With') === 'XMLHttpRequest' ||
    req.is('json')
  );
}

const PROJECT_ROOT = __dirname.endsWith(`${path.sep}dist`) ? path.join(__dirname, '..') : __dirname;

const app = express();
if (process.env.NODE_ENV !== 'test') {
  cronTasks.init();
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(PROJECT_ROOT, 'views'));
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(PROJECT_ROOT, 'public'), { maxAge: '30d', immutable: true }));
app.use(cors({ origin: true, credentials: true }));

// Rate Limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 100, // IP başına 15 dakikada 100 istek
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Çok fazla istek gönderildi, lütfen daha sonra tekrar deneyin.' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 saat
  max: 10, // IP başına saatte en fazla 10 giriş denemesi
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Çok fazla hatalı giriş denemesi yapıldı. Lütfen bir saat sonra tekrar deneyin.' }
});

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 20, // IP başına 15 dakikada en fazla 20 AI isteği
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'AI limitine ulaşıldı. Lütfen biraz bekleyin.' }
});

// Uygula
app.use('/admin/login', authLimiter);
app.use('/admin/ai/', aiLimiter);
app.use('/search', generalLimiter);


let sessionStore: session.Store | undefined;
if (!useTestSessionStore) {
  try {
    const FileStore = sessionFileStore(session);
    sessionStore = new FileStore({ path: './sessions', retries: 1, reapInterval: 0 });
    console.log('Using session-file-store for sessions (./sessions)');
  } catch (err) {
    console.warn('session-file-store not available; using default MemoryStore. To persist sessions across restarts install session-file-store: npm install session-file-store');
  }
} else {
  console.log('Using default MemoryStore during tests');
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    secure: USE_SECURE_COOKIE,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const locales = {
  tr: JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'locales', 'tr.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'locales', 'en.json'), 'utf8'))
};

app.use((req: Request, res: Response, next: NextFunction) => {
  let lang = (req.query.lang as string | undefined) || req.session.lang;

  if (!lang && req.headers['accept-language']) {
    lang = (req.headers['accept-language'] as string).split(',')[0].startsWith('tr') ? 'tr' : 'en';
  }

  lang = lang === 'en' || lang === 'tr' ? lang : 'tr';
  req.session.lang = lang as LanguageCode;

  res.locals.t = (key: string) => {
    const keys = key.split('.');
    let result: unknown = locales[lang as LanguageCode];
    for (const k of keys) {
      if (typeof result === 'object' && result !== null && k in result) {
        result = (result as Record<string, unknown>)[k];
      } else {
        return key;
      }
    }
    return typeof result === 'string' ? result : key;
  };

  res.locals.currentLang = lang;
  res.locals.isAdmin = !!req.session && !!req.session.adminId;
  res.locals.siteUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
  next();
});

const isAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.session.adminId) {
    return next();
  }

  if (acceptsJson(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  res.redirect('/admin/login');
};

app.get('/', async (req: Request, res: Response) => {
  try {
    const games = await db.allAsync<Game>('SELECT * FROM games ORDER BY created_at DESC');
    const posts = await db.allAsync<Post>('SELECT * FROM posts WHERE is_published = 1 ORDER BY created_at DESC LIMIT 3');
    res.render('index', { 
      games, 
      posts,
      title: 'Doomsgame - AI Destekli Oyun ve Haber Platformu',
      description: 'En yeni oyun haberleri ve ücretsiz tarayıcı oyunlarını keşfedin.'
    });
  } catch (err) {
    console.error(getErrorMessage(err));
    res.status(500).render('500', { title: '500 - Sunucu Hatası' });
  }
});

app.get('/game/:id', async (req: Request, res: Response) => {
  try {
    const game = await db.getAsync<Game>('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (!game) return res.status(404).render('404', { title: '404 - Sayfa Bulunamadı' });
    res.render('game', { 
      game,
      title: `${game.title} - Ücretsiz Oyna - Doomsgame`,
      description: `${game.title} oyununu ücretsiz ve tarayıcı üzerinden hemen oyna.`
    });
  } catch (err) {
    console.error(getErrorMessage(err));
    res.status(500).render('500', { title: '500 - Sunucu Hatası' });
  }
});

app.get('/news', async (req: Request, res: Response) => {
  try {
    const posts = await db.allAsync<Post>('SELECT * FROM posts WHERE is_published = 1 ORDER BY created_at DESC');
    res.render('news', { 
      posts,
      title: 'Oyun Haberleri - Doomsgame',
      description: 'Yapay zeka tarafından hazırlanan en güncel teknoloji ve oyun haberleri.'
    });
  } catch (err) {
    console.error(getErrorMessage(err));
    res.status(500).render('500', { title: '500 - Sunucu Hatası' });
  }
});

app.get('/robots.txt', (req: Request, res: Response) => {
  const baseUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml`);
});

app.get('/sitemap.xml', async (req: Request, res: Response) => {
  try {
    const games = await db.allAsync<Game>('SELECT id, created_at FROM games WHERE is_published = 1');
    const posts = await db.allAsync<Post>('SELECT id, created_at FROM posts WHERE is_published = 1');
    const baseUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;

    const rows = [
      `${baseUrl}/`,
      `${baseUrl}/news`
    ].map(url => `  <url>\n    <loc>${url}</loc>\n    <changefreq>daily</changefreq>\n  </url>`);

    games.forEach((game) => {
      rows.push(`  <url>\n    <loc>${baseUrl}/game/${game.id}</loc>\n    <lastmod>${new Date(game.created_at).toISOString()}</lastmod>\n    <changefreq>monthly</changefreq>\n  </url>`);
    });

    posts.forEach((post) => {
      rows.push(`  <url>\n    <loc>${baseUrl}/news/${post.id}</loc>\n    <lastmod>${new Date(post.created_at).toISOString()}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`);
    });

    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>`);
  } catch (err) {
    console.error('Sitemap generation failed:', err);
    res.status(500).send('Sitemap generation failed.');
  }
});

// SEO: Robots.txt
app.get('/robots.txt', (req: Request, res: Response) => {
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: ${SITE_URL}/sitemap.xml`);
});

// SEO: Sitemap.xml
app.get('/sitemap.xml', async (req: Request, res: Response) => {
  try {
    const games = await db.allAsync<any>('SELECT id FROM games WHERE is_published = 1');
    const posts = await db.allAsync<any>('SELECT id FROM posts WHERE is_published = 1');
    
    let xml = '<?xml version="1.0" encoding="UTF-8"?>';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    
    // Core pages
    const staticUrls = ['', '/news'];
    staticUrls.forEach(url => {
      xml += `<url><loc>${SITE_URL}${url}</loc><priority>1.0</priority></url>`;
    });

    // Games
    games.forEach(game => {
      xml += `<url><loc>${SITE_URL}/game/${game.id}</loc><priority>0.8</priority></url>`;
    });

    // Posts
    posts.forEach(post => {
      xml += `<url><loc>${SITE_URL}/news/${post.id}</loc><priority>0.7</priority></url>`;
    });

    xml += '</urlset>';
    res.type('application/xml');
    res.send(xml);
  } catch (err) {
    res.status(500).end();
  }
});

app.get('/news/:id', async (req: Request, res: Response) => {
  try {
    const post = await db.getAsync<Post>('SELECT * FROM posts WHERE id = ? AND is_published = 1', [req.params.id]);
    if (!post) return res.status(404).render('404', { title: '404 - Sayfa Bulunamadı' });
    res.render('post', { 
      post,
      title: `${post.title} - Doomsgame`,
      description: post.title
    });
  } catch (err) {
    console.error(getErrorMessage(err));
    res.status(500).render('500', { title: '500 - Sunucu Hatası' });
  }
});

app.get('/search', async (req: Request, res: Response) => {
  const query = String(req.query.q || '').trim();
  if (!query) {
    return res.redirect('/');
  }

  try {
    const escaped = escapeLike(query);
    const likePattern = `%${escaped}%`;

    const games = await db.allAsync<Game>(
      "SELECT id, title, created_at FROM games WHERE (title LIKE ? ESCAPE '\\' OR embed_code LIKE ? ESCAPE '\\') AND is_published = 1 ORDER BY created_at DESC LIMIT 20",
      [likePattern, likePattern]
    );

    const posts = await db.allAsync<Post>(
      "SELECT id, title, content, created_at FROM posts WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') AND is_published = 1 ORDER BY created_at DESC LIMIT 20",
      [likePattern, likePattern]
    );

    res.render('search', { query, games, posts });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).render('500', { title: '500 - Sunucu Hatası' });
  }
});

app.get('/health', async (req: Request, res: Response) => {
  try {
    await db.getAsync('SELECT 1');
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      database: 'ok',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ status: 'error', database: 'failed', error: getErrorMessage(err) });
  }
});

app.get('/admin/login', (req: Request, res: Response) => {
  if (req.session && req.session.adminId) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin/login', { error: null });
});

app.get('/admin/scraper-logs', isAdmin, (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  res.write(': connected\n\n');
  addSSEClient(res as ServerResponse & { write: (chunk: string) => void });
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {
      // ignore
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
  });
});

app.post('/admin/login', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username: string; password: string };
  try {
    const user = await db.getAsync<User>('SELECT * FROM users WHERE username = ?', [username]);
    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.adminId = user.id;
      req.session.save((err) => {
        if (err) {
          console.error('Session save error:', err);
          return res.render('admin/login', { error: 'Oturum kaydedilemedi. Lütfen tekrar deneyin.' });
        }
        res.redirect('/admin/dashboard');
      });
    } else {
      res.render('admin/login', { error: 'Geçersiz kullanıcı adı veya şifre' });
    }
  } catch (err: unknown) {
    console.error(getErrorMessage(err));
    res.render('admin/login', { error: 'Veritabanı hatası' });
  }
});

app.get('/admin/dashboard', isAdmin, (req: Request, res: Response) => {
  res.render('admin/dashboard');
});

app.post('/admin/add-game', isAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { title, embed_code } = req.body as { title: unknown; embed_code: unknown };
  if (!isNonEmptyString(title) || !isNonEmptyString(embed_code)) {
    return validationError(res, 'Başlık ve embed kodu zorunludur.');
  }

  const trimmedTitle = title.trim();
  const trimmedEmbed = embed_code.trim();
  if (trimmedTitle.length > 200) {
    return validationError(res, 'Başlık 200 karakterden uzun olamaz.');
  }

  await db.runAsync('INSERT INTO games (title, embed_code) VALUES (?, ?)', [trimmedTitle, trimmedEmbed]);

  if (acceptsJson(req)) {
    return res.status(201).json({ success: true, message: 'Oyun başarıyla kaydedildi.' });
  }
  res.redirect('/admin/dashboard');
}));

app.post('/admin/add-post', isAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { title, content } = req.body as { title: unknown; content: unknown };
  if (!isNonEmptyString(title) || !isNonEmptyString(content)) {
    return validationError(res, 'Başlık ve içerik zorunludur.');
  }

  const trimmedTitle = title.trim();
  const trimmedContent = content.trim();
  if (trimmedTitle.length > 200) {
    return validationError(res, 'Başlık 200 karakterden uzun olamaz.');
  }

  await db.runAsync('INSERT INTO posts (title, content) VALUES (?, ?)', [trimmedTitle, trimmedContent]);

  if (acceptsJson(req)) {
    return res.status(201).json({ success: true, message: 'Yazı başarıyla kaydedildi.' });
  }
  res.redirect('/admin/dashboard');
}));

app.post('/admin/ai/generate-post', isAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { topic } = req.body as { topic: unknown };
  if (!isNonEmptyString(topic)) {
    return validationError(res, 'Konu alanı boş olamaz.');
  }
  const draft = await aiService.generatePostDraft(topic.trim());
  res.json({ success: true, draft });
}));

app.post('/admin/ai/suggest-game', isAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { query } = req.body as { query: unknown };
  if (!isNonEmptyString(query)) {
    return validationError(res, 'Sorgu alanı boş olamaz.');
  }
  const suggestions = await aiService.suggestGameEmbeds(query.trim());
  res.json({ success: true, suggestions });
}));

app.post('/admin/run-scraper', isAdmin, async (req: Request, res: Response) => {
  try {
    await cronTasks.runDailyScraperLoop();
    res.json({ success: true, message: 'Scraper run triggered' });
  } catch (err: unknown) {
    console.error('Manual scraper run error:', getErrorMessage(err));
    res.status(500).json({ success: false, error: getErrorMessage(err) || 'Internal error' });
  }
});

app.post('/admin/ai/feedback', isAdmin, async (req: Request, res: Response) => {
  const { id, type, message } = req.body as { id: unknown; type: unknown; message: unknown };
  const itemId = parsePositiveInt(id);
  if (!itemId || !isNonEmptyString(type) || !isNonEmptyString(message)) {
    return validationError(res, 'Eksik veya geçersiz parametre.');
  }
  if (type !== 'post' && type !== 'game') {
    return validationError(res, 'Geçersiz içerik tipi.');
  }

  try {
    let existing: Post | Game | undefined;
    if (type === 'post') {
      existing = await db.getAsync<Post>('SELECT * FROM posts WHERE id = ?', [itemId]);
      if (!existing) return res.status(404).json({ success: false, error: 'Post bulunamadı' });
    } else {
      existing = await db.getAsync<Game>('SELECT * FROM games WHERE id = ?', [itemId]);
      if (!existing) return res.status(404).json({ success: false, error: 'Oyun bulunamadı' });
    }

    let prompt: string;
    if (type === 'post') {
      prompt = `Aşağıdaki HABER/MAKALE içeriğini gözden geçir ve kullanıcının geri bildirimine göre düzelt veya yeniden yaz.\n\nMEVCUT İÇERİK:\n${(existing as Post).content}\n\nGERİ BİLDİRİM:\n${message}\n\nLütfen yalnızca düzeltilmiş HTML içeriğini döndür.`;
    } else {
      prompt = `Aşağıdaki oyun embed kodunu gözden geçir ve kullanıcının geri bildirimine göre düzelt. Eğer embed kodunda güvenlik/syntax hatası varsa düzelt ve sadece çalışır durumda embed kodunu döndür.\n\nMEVCUT KOD:\n${(existing as Game).embed_code}\n\nGERİ BİLDİRİM:\n${message}`;
    }

    const aiResponse = await aiService.generateWithRetry(prompt);

    if (type === 'post') {
      await db.runAsync('UPDATE posts SET content = ? WHERE id = ?', [aiResponse, itemId]);
    } else {
      await db.runAsync('UPDATE games SET embed_code = ? WHERE id = ?', [aiResponse, itemId]);
    }

    await db.runAsync('INSERT INTO pending_feedback (content_type, content_id, user_message, ai_response) VALUES (?, ?, ?, ?)', [type, id, message, aiResponse]);
    res.json({ success: true, updated: aiResponse });
  } catch (error: unknown) {
    console.error('Feedback handler error:', getErrorMessage(error));
    res.status(500).json({ success: false, error: 'AI işlemi başarısız oldu.' });
  }
});

app.get('/api/task-status', (req: Request, res: Response) => {
  try {
    if (!req.session.adminId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    let tasks: Array<{ name: string; schedule: string; status: string }> = [];
    if (cronTasks && typeof cronTasks.getTaskStatus === 'function') {
      try {
        tasks = cronTasks.getTaskStatus() || [];
      } catch (e) {
        console.error('cronTasks.getTaskStatus threw:', e);
        tasks = [];
      }
    }

    if (!tasks || tasks.length === 0) {
      tasks = [
        { name: 'Günlük Haber Tarama', schedule: '-', status: 'Beklemede' },
        { name: 'Haftalık Oyun Keşfi', schedule: '-', status: 'Beklemede' },
        { name: 'Otonom Editör Döngüsü', schedule: (cronTasks && (cronTasks as any).tasks && (cronTasks as any).tasks.dailyScraper) ? (cronTasks as any).tasks.dailyScraper.schedule : '-', status: 'Beklemede' }
      ];
    }

    res.json({ success: true, tasks });
  } catch (err: unknown) {
    console.error('Error in /api/task-status:', err);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

app.get('/api/admin/overview', isAdmin, asyncHandler(async (req: Request, res: Response) => {
  const publishedGames = await db.getAsync<{ count: number }>('SELECT COUNT(*) AS count FROM games WHERE is_published = 1');
  const publishedPosts = await db.getAsync<{ count: number }>('SELECT COUNT(*) AS count FROM posts WHERE is_published = 1');
  const draftGames = await db.getAsync<{ count: number }>('SELECT COUNT(*) AS count FROM games WHERE is_published = 0');
  const draftPosts = await db.getAsync<{ count: number }>('SELECT COUNT(*) AS count FROM posts WHERE is_published = 0');
  const pendingFeedback = await db.getAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_feedback');
  const sourceCount = await db.getAsync<{ count: number }>('SELECT COUNT(*) AS count FROM editor_sources');
  const autoPilot = await db.getAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'auto_pilot_enabled'");
  const timer = await db.getAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'autonomous_timer'");

  res.json({
    success: true,
    overview: {
      publishedGames: publishedGames?.count || 0,
      publishedPosts: publishedPosts?.count || 0,
      draftGames: draftGames?.count || 0,
      draftPosts: draftPosts?.count || 0,
      pendingFeedback: pendingFeedback?.count || 0,
      sourceCount: sourceCount?.count || 0,
      autoPilot: autoPilot?.value === '1',
      timer: timer?.value || '0 9 * * *'
    }
  });
}));

app.get('/admin/ai/sources', isAdmin, async (req: Request, res: Response) => {
  try {
    const sources = await db.allAsync<EditorSource>('SELECT * FROM editor_sources');
    res.json({ success: true, sources });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.post('/admin/ai/sources', isAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { sources } = req.body as { sources: unknown };
  if (!validateSourcesPayload(sources)) {
    return validationError(res, 'Geçersiz kaynak listesi.');
  }

  await db.runAsync('BEGIN TRANSACTION');
  try {
    await db.runAsync('DELETE FROM editor_sources');
    for (const s of sources) {
      await db.runAsync('INSERT INTO editor_sources (url, type) VALUES (?, ?)', [s.url, s.type]);
    }
    await db.runAsync('COMMIT');
    res.json({ success: true });
  } catch (error: unknown) {
    await db.runAsync('ROLLBACK');
    throw error;
  }
}));

app.get('/admin/ai/timer', isAdmin, async (req: Request, res: Response) => {
  try {
    const setting = await db.getAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'autonomous_timer'");
    res.json({ success: true, timer: setting ? setting.value : '0 9 * * *' });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.post('/admin/ai/timer', isAdmin, async (req: Request, res: Response) => {
  let { timer } = req.body as { timer: string };
  if (!timer) return res.status(400).json({ success: false, error: 'Zamanlayıcı verisi eksik.' });

  try {
    const timeMatch = timer.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (timeMatch) {
      const [, hour, minute] = timeMatch;
      timer = `0 ${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;
      console.log(`⏰ Saat formatı algılandı (${timeMatch[0]}), Cron'a çevrildi: ${timer}`);
    }

    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      'autonomous_timer',
      timer
    ]);
    cronTasks.rescheduleAutonomousLoop(timer);
    res.json({ success: true, convertedTimer: timer });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.get('/admin/ai/auto-pilot', isAdmin, async (req: Request, res: Response) => {
  try {
    const setting = await db.getAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'auto_pilot_enabled'");
    res.json({ success: true, enabled: setting ? setting.value === '1' : false });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.post('/admin/ai/auto-pilot', isAdmin, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled: boolean };
  try {
    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      'auto_pilot_enabled',
      enabled ? '1' : '0'
    ]);
    res.json({ success: true });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.get('/admin/drafts', isAdmin, async (req: Request, res: Response) => {
  try {
    const draftPosts = await db.allAsync<Post>('SELECT * FROM posts WHERE is_published = 0 ORDER BY created_at DESC');
    const draftGames = await db.allAsync<Game>('SELECT * FROM games WHERE is_published = 0 ORDER BY created_at DESC');
    res.json({ success: true, posts: draftPosts, games: draftGames });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.post('/admin/action/publish', isAdmin, async (req: Request, res: Response) => {
  const { id, type } = req.body as { id: unknown; type: unknown };
  const itemId = parsePositiveInt(id);
  if (!itemId || !isNonEmptyString(type)) {
    return validationError(res, 'Eksik veya geçersiz parametre.');
  }
  if (type !== 'post' && type !== 'game') {
    return validationError(res, 'Geçersiz içerik tipi.');
  }

  try {
    const table = type === 'post' ? 'posts' : 'games';
    await db.runAsync(`UPDATE ${table} SET is_published = 1 WHERE id = ?`, [itemId]);
    res.json({ success: true });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.post('/admin/action/delete', isAdmin, async (req: Request, res: Response) => {
  const { id, type } = req.body as { id: unknown; type: unknown };
  const itemId = parsePositiveInt(id);
  if (!itemId || !isNonEmptyString(type)) {
    return validationError(res, 'Eksik veya geçersiz parametre.');
  }
  if (type !== 'post' && type !== 'game') {
    return validationError(res, 'Geçersiz içerik tipi.');
  }

  try {
    const table = type === 'post' ? 'posts' : 'games';
    await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [itemId]);
    res.json({ success: true });
  } catch (error: unknown) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

app.get('/admin/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// 404 Handler - Her zaman en sonda olmalı
app.use((req: Request, res: Response) => {
  res.status(404).render('404', { 
    title: res.locals.t('error.404_title') || '404 - Sayfa Bulunamadı',
    message: res.locals.t('error.404_message') || 'Aradığınız sayfa kaldırılmış veya hiç var olmamış olabilir.'
  });
});

// Global Central Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('🔥 GLOBAL ERROR:', err.stack);
  
  const status = err.status || 500;
  res.status(status);

  if (acceptsJson(req)) {
    return res.json({ 
      success: false, 
      error: NODE_ENV === 'production' ? 'Sunucu tarafında bir hata oluştu.' : err.message 
    });
  }

  res.render('500', { 
    title: '500 - Sunucu Hatası',
    error: NODE_ENV === 'production' ? null : err.stack
  });
});


const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

export default app;
