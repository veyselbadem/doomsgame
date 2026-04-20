import cron, { ScheduledTask } from 'node-cron';
import db from './database';
import aiService from './ai_service';
import scraperService from './scraper_service';
import { send as sendSSE } from './sse_logger';

interface EditorSource {
  id: number;
  url: string;
  type: 'news' | 'game';
  last_scraped: string | null;
}

interface CronTaskInfo {
  name: string;
  schedule: string;
  status: string;
  job?: ScheduledTask | null;
}

interface TaskMap {
  dailyNews: CronTaskInfo;
  weeklyDiscovery: CronTaskInfo;
  dailyScraper: CronTaskInfo;
}

class CronTasks {
  public tasks: TaskMap;

  constructor() {
    this.tasks = {
      dailyNews: {
        name: 'Günlük Haber Tarama',
        schedule: '0 10 * * *',
        status: 'Bekliyor'
      },
      weeklyDiscovery: {
        name: 'Haftalık Oyun Keşfi',
        schedule: '0 10 * * 1',
        status: 'Bekliyor'
      },
      dailyScraper: {
        name: 'Otonom Editör Döngüsü',
        schedule: '0 9 * * *',
        status: 'Bekliyor',
        job: null
      }
    };
  }

  formatCron(str: string) {
    if (!str || typeof str !== 'string') return '0 9 * * *';
    const hhmm = str.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (hhmm) {
      const [, hour, minute] = hhmm;
      return `0 ${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`;
    }
    if (str.split(' ').length >= 5) {
      return str;
    }
    return '0 9 * * *';
  }

  async init() {
    console.log('Cron tasks initializing...');

    try {
      const setting = await db.getAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'autonomous_timer'");
      if (setting) {
        this.tasks.dailyScraper.schedule = this.formatCron(setting.value);
        console.log(`⏱️ Kayıtlı Otonom Zamanlayıcı (Formatlanmış): ${this.tasks.dailyScraper.schedule}`);
      }
    } catch (error) {
      console.error('Zamanlayıcı yükleme hatası:', error);
    }

    const finalSchedule = this.formatCron(this.tasks.dailyScraper.schedule);
    this.tasks.dailyScraper.job = cron.schedule(finalSchedule, async () => {
      await this.runDailyScraperLoop();
    });

    console.log('Cron tasks scheduled.');
  }

  rescheduleAutonomousLoop(newSchedule: string) {
    if (this.tasks.dailyScraper.job) {
      this.tasks.dailyScraper.job.stop();
    }
    const sanitized = this.formatCron(newSchedule);
    this.tasks.dailyScraper.schedule = sanitized;
    this.tasks.dailyScraper.job = cron.schedule(sanitized, async () => {
      await this.runDailyScraperLoop();
    });
    console.log(`♻️ Otonom döngü yeniden programlandı: ${sanitized}`);
  }

  async runDailyScraperLoop() {
    console.log('🚀 Otonom Editör Döngüsü Başlatıldı...');
    sendSSE('Otonom Editör Döngüsü Başlatıldı...');
    this.tasks.dailyScraper.status = 'Çalışıyor';

    try {
      const sources = await db.allAsync<EditorSource>('SELECT * FROM editor_sources');
      const autoPilotSetting = await db.getAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'auto_pilot_enabled'");
      const isAutoPilotOn = autoPilotSetting && autoPilotSetting.value === '1';

      for (const source of sources) {
        console.log(`🔍 Kaynak taranıyor: ${source.url} (${source.type})`);

        try {
          if (source.type === 'news') {
            sendSSE(`Kaynak taranıyor (haber): ${source.url}`);
            try {
              const result = await scraperService.scrapeLatestFromHomepage(source.url);
              if (result && result.title) {
                console.log(`✅ Haber işlendi: ${result.title} (kaynak: ${result.source})`);
                sendSSE(`Haber işlendi: ${result.title}`);
              } else {
                console.log('⚠️ Haber işlendi fakat dönen sonuç beklenenden farklı.');
                sendSSE('Haber işlendi fakat sonuç beklenenden farklı.');
              }
            } catch (error) {
              console.error('Haber işleme hatası:', (error as Error).message || error);
              sendSSE(`Haber işleme hatası: ${(error as Error).message || error}`);
            }
          } else if (source.type === 'game') {
            const verified = await scraperService.scrapeAndTestGame(source.url);

            if (verified && verified.code && verified.title) {
              const existingGame = await db.getAsync('SELECT id FROM games WHERE title = ? OR embed_code = ?', [verified.title, verified.code]);
              if (existingGame) {
                console.log(`⏭️ Oyun zaten var, atlanıyor: ${verified.title}`);
                continue;
              }

              const healingPrompt = `
                                Bu oyunun kalitesini 1-10 arası puanla ve mobilde taşıyorsa %100 responsive yap.
                                Kod: ${verified.code}
                                SADECE JSON: {"healedCode": "...", "score": 9}
                            `;
              const healedRaw = await aiService.generateWithRetry(healingPrompt);
              const healedData = JSON.parse(healedRaw.replace(/```json/g, '').replace(/```/g, '').trim());

              let publishStatus = 0;
              if (isAutoPilotOn && healedData.score >= 8) {
                publishStatus = 1;
                console.log(`🚀 OTO-PİLOT: Oyun yayına alındı (${healedData.score} puan).`);
              }

              await db.runAsync('INSERT INTO games (title, embed_code, is_published, quality_score) VALUES (?, ?, ?, ?)', [
                verified.title,
                healedData.healedCode || verified.code,
                publishStatus,
                healedData.score || 0
              ]);
            }
          }

          await db.runAsync('UPDATE editor_sources SET last_scraped = CURRENT_TIMESTAMP WHERE id = ?', [source.id]);
        } catch (error) {
          console.error('❌ İşleme hatası:', (error as Error).message || error);
        }

        const delay = Math.floor(Math.random() * 10000) + 5000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      this.tasks.dailyScraper.status = 'Sonlandı (Başarılı)';
    } catch (error) {
      console.error('Fatal error in Daily Scraper Loop:', error);
      this.tasks.dailyScraper.status = 'Kritik Hata';
    }
  }

  getTaskStatus() {
    try {
      const tasks = this.tasks || {};
      const keys = Object.keys(tasks);
      if (keys.length === 0) {
        return [
          { name: 'Günlük Haber Tarama', schedule: '-', status: 'Beklemede' },
          { name: 'Haftalık Oyun Keşfi', schedule: '-', status: 'Beklemede' },
          { name: 'Otonom Editör Döngüsü', schedule: '-', status: 'Beklemede' }
        ];
      }

      return keys.map((k) => {
        const t = tasks[k as keyof TaskMap] as CronTaskInfo;
        return {
          name: t.name ? String(t.name) : String(k),
          schedule: t.schedule ? String(t.schedule) : '-',
          status: t.status ? String(t.status) : 'Beklemede'
        };
      });
    } catch (error) {
      console.error('getTaskStatus error:', error);
      return [
        { name: 'Günlük Haber Tarama', schedule: '-', status: 'Beklemede' },
        { name: 'Haftalık Oyun Keşfi', schedule: '-', status: 'Beklemede' },
        { name: 'Otonom Editör Döngüsü', schedule: '-', status: 'Beklemede' }
      ];
    }
  }
}

export default new CronTasks();
