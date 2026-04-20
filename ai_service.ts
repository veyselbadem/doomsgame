import { GoogleGenerativeAI } from '@google/generative-ai';
import db from './database';

interface GenerativeModel {
  generateContent(prompt: string): Promise<{ response: { text(): string } }>;
}

class AIService {
  private apiKey?: string;
  private genAI: unknown = null;
  private activeModel: GenerativeModel | null = null;
  private currentModelName: string | null = null;
  private failedModels = new Set<string>();

  private modelPriority = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-lite-001'
  ];

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;

    if (!this.apiKey) {
      console.warn('⚠️ UYARI: GEMINI_API_KEY .env dosyasında henüz yüklenmemiş olabilir.');
    } else {
      console.log(`🤖 AI Servisi Başlatılıyor. Anahtar Kontrolü (İlk 8 karakter): ${this.apiKey.substring(0, 8)}...`);
    }
  }

  private initGenAI() {
    if (!this.genAI) {
      this.apiKey = process.env.GEMINI_API_KEY;
      if (!this.apiKey) {
        throw new Error('CRITICAL: GEMINI_API_KEY hâlâ yüklenemedi!');
      }
      const GenAIClass = GoogleGenerativeAI as any;
      this.genAI = new GenAIClass(this.apiKey);
    }
  }

  private createModel(modelName: string): GenerativeModel {
    this.initGenAI();
    return (this.genAI as any).getGenerativeModel(
      { model: modelName },
      { apiVersion: 'v1' }
    ) as GenerativeModel;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async getNextAvailableModel(): Promise<GenerativeModel> {
    for (const modelName of this.modelPriority) {
      if (!this.failedModels.has(modelName)) {
        console.log('⚡ Yeni model denemesi:', modelName);
        this.currentModelName = modelName;
        return this.createModel(modelName);
      }
    }
    throw new Error('Listedeki 20+ modelin hiçbiri bu API anahtarı ile çalışmadı. API anahtarı yetkilerini kontrol edin.');
  }

  async generateWithRetry(prompt: string, retries = 25): Promise<string> {
    try {
      if (!this.activeModel) {
        this.activeModel = await this.getNextAvailableModel();
      }

      const result = await this.activeModel.generateContent(prompt);
      return result.response.text();
    } catch (error: unknown) {
      const errorInfo = error as { status?: number; code?: string };
      const status = errorInfo.status;
      const code = errorInfo.code;
      if (
        (status === 429 || status === 500 || status === 503 ||
          code === 'ECONNRESET' || code === 'ETIMEDOUT') &&
        retries > 0
      ) {
        console.log(`⏳ Kota/Sunucu yoğunluğu (${status}). 30 saniye bekleniyor...`);
        await this.sleep(30000);
        return this.generateWithRetry(prompt, retries - 1);
      }

      if ((status === 404 || status === 403) && retries > 0) {
        console.log(`🚫 Model bulunamadı/yetki yok (${status}):`, this.currentModelName);
        if (this.currentModelName) this.failedModels.add(this.currentModelName);
        this.activeModel = null;
        return this.generateWithRetry(prompt, retries - 1);
      }

      console.error('❌ AI Servis Kalıcı Hata:', (error as Error).message || String(error));
      return 'Şu anda içerik üretilemiyor, lütfen terminal loglarını kontrol edin.';
    }
  }

  async getCache(queryKey: string, type: string) {
    try {
      const cached = await db.getAsync<{ responseContent: string }>('SELECT responseContent FROM ai_cache WHERE queryKey = ? AND type = ?', [queryKey, type]);
      return cached ? cached.responseContent : null;
    } catch (err) {
      console.error('Cache Read Error:', err);
      return null;
    }
  }

  async setCache(queryKey: string, responseContent: string, type: string) {
    try {
      await db.runAsync('INSERT INTO ai_cache (queryKey, responseContent, type) VALUES (?, ?, ?)', [queryKey, responseContent, type]);
    } catch (err) {
      console.error('Cache Write Error:', err);
    }
  }

  async generatePostDraft(text: string) {
    if (!text || text.length < 100) {
      console.warn('⚠️ AI için yetersiz içerik.');
      return 'Haber içeriği bulunamadı veya çok kısa.';
    }

    const prompt = `
Aşağıdaki ham metni analiz et ve KESİNLİKLE uydurma yapmadan güncel bir haber yazısı oluştur.
SADECE aşağıdaki JSON formatında cevap ver:
{
  "title": "Haber başlığı",
  "content": "HTML formatında ana haber içeriği",
  "summary": ["madde 1", "madde 2", "madde 3"],
  "insight": "Yapay zekanın bu konudaki özel yorumu ve analizi",
  "category": "Teknoloji",
  "tags": "etiket1, etiket2",
  "youtube_query": "konuyla ilgili youtube arama terimi"
}

TARİH: Mart 2026.
PROFİL: IGN Türkiye profesyonel dili. 
NOT: 'summary' alanı haberin en önemli 3 noktasını içeren bir dizi (array) olmalıdır.

HAM METİN:
${text}
`;

    const response = await this.generateWithRetry(prompt);
    try {
      const cleaned = response.replace(/```json/g, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const defaultData = { content: response, category: 'Genel', tags: '', summary: [], insight: '', youtube_query: '' };
      return jsonMatch ? JSON.parse(jsonMatch[0]) : defaultData;
    } catch {
      return { content: response, category: 'Genel', tags: '', summary: [], insight: '', youtube_query: '' };
    }
  }

  async suggestGameEmbeds(query: string) {
    const cachedResponse = await this.getCache(query, 'game_embed');
    if (cachedResponse) {
      console.log('Cache Hit: suggestGameEmbeds', query);
      try {
        return JSON.parse(cachedResponse);
      } catch {
        return [];
      }
    }

    const prompt = `
"${query}" için web tabanlı oyunları öner. SADECE aşağıdaki JSON ARRAY formatında cevap ver:
[{"title": "Oyun Adı", "reason": "Neden önerildi", "embed_code": "html_iframe", "category": "Aksiyon, Yarış, vb.", "tags": "tag1, tag2"}]
`;
    try {
      const text = await this.generateWithRetry(prompt);

      if (text && !text.startsWith('Şu anda içerik üretilemiyor')) {
        await this.setCache(query, text, 'game_embed');
      }

      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (error) {
      console.error('Oyun önerme hatası:', error);
      return [];
    }
  }
}

export default new AIService();
