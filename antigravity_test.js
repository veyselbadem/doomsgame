require('dotenv').config();
const express = require('express');
const app = express();
const port = 5000;
// Gerçek Modülleri Bağlıyoruz
const cronTasks = require('./cron_tasks');

app.get('/debug-test', (req, res) => {
    res.send('🎯 HEDEF VURULDU! Otonom Sistem Hazir.');
});

// İŞTE GERÇEK TETİKLEYİCİ
app.get('/admin/start-task', async (req, res) => {
    try {
        console.log("🚀 MANUEL TETIKLEME: Otonom Kazıma Döngüsü Başlatılıyor...");
        // Bu fonksiyon senin scraper'ı, Gemini'yi ve görsel oluşturucuyu sırayla çalıştırır
        cronTasks.runDailyScraperLoop();
        res.send("🚀 KAZIMA BAŞLATILDI! Terminali izle, oyunlar geliyor...");
    } catch (err) {
        console.error("Hata:", err);
        res.status(500).send("Hata Oluştu: " + err.message);
    }
});

app.listen(port, () => {
    console.log('\n******************************************');
    console.log('🔥 DOOMSGAME OTONOM MOTORU CALISIYOR!');
    console.log('👉 Tetiklemek İçin: http://localhost:5000/admin/start-task');
    console.log('******************************************');
});
