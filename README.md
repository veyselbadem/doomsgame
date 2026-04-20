# Doomsgame.com Backend

Bu proje, doomsgame.com için Node.js + Express + SQLite tabanlı bir backend ve admin panel yapısıdır.

## Kurulum ve Çalıştırma

1. **Bağımlılıkları Yükleyin:**
   Terminalde proje dizinine gidin ve şu komutu çalıştırın:
   ```bash
   npm install
   ```

2. **Çevresel Değişkenleri Oluşturun:**
   `.env.example` dosyasını kopyalayarak bir `.env` dosyası oluşturun ve gerekli değerleri ayarlayın:
   ```bash
   cp .env.example .env
   ```

3. **Proje Derleyin:**
   ```bash
   npm run build
   ```

4. **Sunucuyu Başlatın:**
   ```bash
   npm start
   ```
   Sunucu şu adreste çalışacaktır: `http://localhost:3000`

5. **Geliştirme Modu:**
   ```bash
   npm run dev
   ```

## Özellikler

- **Admin Paneli:** `http://localhost:3000/admin/login`
  - **Varsayılan Giriş:**
    - **Kullanıcı Adı:** `admin`
    - **Şifre:** `admin123`
- **Oyun Yönetimi:** Admin panelinden embed kodu (iframe) ile yeni oyunlar ekleyebilirsiniz.
- **Blog Sistemi:** Yeni blog yazıları yazabilir ve ana sayfada listeleyebilirsiniz.
- **AI Destekli İçerik:** AI destekli haber taslağı ve oyun önerileri hizmetleri mevcut.
- **Veritabanı:** Tüm veriler yerel `doomsgame.db` (SQLite) dosyasına kaydedilir.
- **Canlı İzleme & Sağlık Kontrolü:**
  - `http://localhost:3000/health` — uygulama ve DB bağlantısını kontrol eder.
  - `npm run healthcheck` — yerel sağlık kontrolünü çalıştırır.
- **Otomatik Güvenlik Denetimi:**
  - `npm run audit` — bağımlılık güvenlik açıklarını tarar.

## GitHub Actions ve Deploy

Bu projede CI için `.github/workflows/ci.yml` eklendi. Aşağıdaki adımlar otomatik olarak çalışır:

- kod derleme
- lint kontrolü
- test çalıştırma
- güvenlik denetimi
- sağlık kontrolü

Canlı ortama deploy etmek için GitHub Secrets içinde aşağıdaki değerleri ayarlayabilirsiniz:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_KEY`
- `DEPLOY_PATH`
- `SITE_URL`

Bu değerleri ayarladıktan sonra, GitHub Actions deploy iş akışını etkinleştirmek için ilgili workflow dosyası oluşturulacak veya yapılandırılacaktır.

## Dosya Yapısı
- `server.ts`: Ana Express sunucu dosyası.
- `database.ts`: SQLite veritabanı şeması ve ilklendirme.
- `views/`: EJS şablon dosyaları (Görünüm).
- `public/`: Statik varlıklar.
- `dist/`: TypeScript derleme çıktısı.
- `package.json`: Proje bağımlılıkları ve scriptler.
- `.env.example`: Çevresel değişken örneği.
