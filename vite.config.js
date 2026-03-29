import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'api-scrape-middleware',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith('/api/scrape')) {
            try {
              const urlObj = new URL(req.url, `http://${req.headers.host}`);
              let targetUrl = urlObj.searchParams.get('url');
              if (!targetUrl) return res.end(JSON.stringify({ error: 'url is required' }));

              // 1. URL 정규화
              const idMatch = targetUrl.match(/place\/(\d+)/) || targetUrl.match(/restaurant\/(\d+)/);
              if (idMatch) {
                targetUrl = `https://pcmap.place.naver.com/restaurant/${idMatch[1]}/menu/list`;
              }

              // 2. 스크래핑 로직 실행
              const response = await axios.get(targetUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                }
              });

              const html = response.data;
              const regex = /https:\/\/(search\.pstatic\.net|ldb-phinf\.pstatic\.net)[^"'\s>\\{}]+/g;
              const matches = html.match(regex) || [];
              const uniqueImages = [...new Set(matches)]
                .map(img => img.replace(/\\u002F/g, '/'))
                .filter(img => !img.includes('type=f30_30'));

              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ 
                images: uniqueImages,
                count: uniqueImages.length,
                targetUrl: targetUrl
              }));
            } catch (error) {
              console.error("Vite API Scrape Error:", error.message);
              res.statusCode = 500;
              return res.end(JSON.stringify({ error: error.message }));
            }
          }

          // 3. 이미지 프록시 로직 (CORS 우회용)
          if (req.url?.startsWith('/api/proxy-image')) {
            try {
              const urlObj = new URL(req.url, `http://${req.headers.host}`);
              const imageUrl = urlObj.searchParams.get('url');
              if (!imageUrl) return res.end('url is required');

              const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Referer': 'https://map.naver.com/', // 네이버 이미지 서버의 Referer 체크 우회
                }
              });

              res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
              res.setHeader('Access-Control-Allow-Origin', '*'); // 클라이언트 사이드 처리를 위한 명시적 허용
              return res.end(Buffer.from(response.data));
            } catch (error) {
              console.error("Vite API Proxy Error:", error.message);
              res.statusCode = 500;
              return res.end('Proxy Error');
            }
          }
          next();
        });
      }
    }
  ],
})
