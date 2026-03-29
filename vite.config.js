import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import axios from 'axios'

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

              // 1. place ID 추출
              const idMatch = targetUrl.match(/place\/(\d+)/) || targetUrl.match(/restaurant\/(\d+)/);
              const placeId = idMatch ? idMatch[1] : null;
              if (!placeId) return res.end(JSON.stringify({ error: 'place ID를 찾을 수 없습니다.' }));

              console.log(`\n[Scrape] placeId: ${placeId}`);

              // 공통 헤더
              const naverHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'ko-KR,ko;q=0.9',
                'Referer': `https://pcmap.place.naver.com/restaurant/${placeId}/menu/list`,
                'Origin': 'https://pcmap.place.naver.com',
              };

              let menuItems = [];

              // 2. Naver Place 공개 JSON API 시도
              try {
                const apiRes = await axios.get(
                  `https://map.naver.com/p/api/place/restaurant/${placeId}`,
                  { headers: naverHeaders }
                );
                console.log('[API] status:', apiRes.status, '| keys:', Object.keys(apiRes.data || {}));
                const menus = apiRes.data?.menuList || apiRes.data?.menus || apiRes.data?.result?.menuList;
                if (menus?.length) {
                  menuItems = menus.map(m => ({
                    name: m.name || m.menuName || '',
                    description: m.description || m.desc || '',
                    price: m.price != null ? String(m.price) : '',
                    imageUrl: m.images?.[0]?.url || m.imageUrl || m.photo || ''
                  }));
                  console.log(`[API] 메뉴 ${menuItems.length}개 추출`);
                }
              } catch (e) {
                console.warn('[API] 실패:', e.message);
              }

              // 3. GraphQL 시도
              if (menuItems.length === 0) {
                try {
                  const gqlRes = await axios.post(
                    'https://pcmap-api.place.naver.com/place/graphql',
                    [{
                      operationName: 'getMenuInfo',
                      variables: { id: placeId, deviceType: 'pcmap' },
                      query: `query getMenuInfo($id: String!, $deviceType: String) {
                        restaurant(id: $id, deviceType: $deviceType) {
                          menuList { name price description images { url } }
                          menus { name price description images { url } }
                        }
                      }`
                    }],
                    { headers: { ...naverHeaders, 'Content-Type': 'application/json' } }
                  );
                  const data = gqlRes.data?.[0]?.data?.restaurant;
                  console.log('[GQL] restaurant keys:', Object.keys(data || {}));
                  const menus = data?.menuList || data?.menus;
                  if (menus?.length) {
                    menuItems = menus.map(m => ({
                      name: m.name || '',
                      description: m.description || '',
                      price: m.price != null ? String(m.price) : '',
                      imageUrl: m.images?.[0]?.url || ''
                    }));
                    console.log(`[GQL] 메뉴 ${menuItems.length}개 추출`);
                  } else {
                    console.warn('[GQL] 메뉴 없음. 응답:', JSON.stringify(gqlRes.data).slice(0, 300));
                  }
                } catch (e) {
                  console.warn('[GQL] 실패:', e.message);
                }
              }

              // 4. HTML 파싱 fallback
              if (menuItems.length === 0) {
                const pageRes = await axios.get(
                  `https://pcmap.place.naver.com/restaurant/${placeId}/menu/list`,
                  { headers: naverHeaders }
                );
                const html = pageRes.data;
                console.log(`[HTML] 길이: ${html.length}`);

                // 4a. __NEXT_DATA__ 재귀 탐색
                const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                if (ndMatch) {
                  try {
                    const findMenus = (obj, depth = 0) => {
                      if (!obj || typeof obj !== 'object' || depth > 15) return null;
                      if (Array.isArray(obj)) {
                        for (const el of obj) { const r = findMenus(el, depth+1); if (r) return r; }
                        return null;
                      }
                      for (const key of Object.keys(obj)) {
                        if (['menuList','menus','menuItems'].includes(key) && Array.isArray(obj[key]) && obj[key].length && (obj[key][0]?.name || obj[key][0]?.menuName)) {
                          console.log(`[NEXT_DATA] "${key}" 발견, ${obj[key].length}개`);
                          return obj[key].map(m => ({
                            name: m.name || m.menuName || '',
                            description: m.description || '',
                            price: m.price != null ? String(m.price) : '',
                            imageUrl: m.images?.[0]?.url || m.imageUrl || m.photo || ''
                          }));
                        }
                        const r = findMenus(obj[key], depth+1);
                        if (r) return r;
                      }
                      return null;
                    };
                    const found = findMenus(JSON.parse(ndMatch[1]));
                    if (found?.length) menuItems = found;
                  } catch(e) { console.warn('[NEXT_DATA] parse error:', e.message); }
                }

                // 4b. HZmgf 컨테이너 파싱
                if (menuItems.length === 0) {
                  // "메뉴판 이미지로 보기" 섹션을 찾아 해당 섹션 이전까지만 사용
                  let processHtml = html;
                  const menuBoardMatch = html.match(/class="place_section_header_title"[^>]*>[^<]*메뉴판 이미지로 보기/);
                  if (menuBoardMatch) {
                    const sectionStart = html.lastIndexOf('<div', menuBoardMatch.index);
                    processHtml = sectionStart !== -1 ? html.slice(0, sectionStart) : html;
                    console.log('[HTML] "메뉴판 이미지로 보기" 섹션 제거 (pos:', sectionStart, ')');
                  }

                  const chunks = processHtml.split(/class="HZmgf"/);
                  console.log(`[HTML] HZmgf 컨테이너 수: ${chunks.length - 1}`);
                  chunks.shift();
                  menuItems = chunks.map((chunk, i) => {
                    const nameMatch  = chunk.match(/class="lPzHi"[^>]*>([^<]+)</);
                    const descMatch  = chunk.match(/class="okI98"[^>]*>([^<]+)</);
                    const priceMatch = chunk.match(/class="p2H02"[^>]*>([^<]+)</);
                    const imgMatch   =
                      chunk.match(/(?:src|data-src)="(https?:\/\/[^"]*pstatic\.net[^"]*)"/) ||
                      chunk.match(/"(https:\\u002F\\u002F[^"]*pstatic[^"\\]+)"/);
                    const imageUrl = imgMatch ? imgMatch[1].replace(/\\u002F/g,'/').replace(/\\u0026/g,'&') : '';
                    if (i < 3) console.log(`[HTML] chunk[${i}] name=${nameMatch?.[1]} img=${imageUrl.slice(0,60)}`);
                    return { name: nameMatch?.[1]?.trim()||'', description: descMatch?.[1]?.trim()||'', price: priceMatch?.[1]?.trim()||'', imageUrl };
                  }).filter(item => item.name || item.imageUrl);
                }
              }

              console.log(`[Scrape 완료] 메뉴 ${menuItems.length}개\n`);
              const images = menuItems.map(i => i.imageUrl).filter(Boolean);
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ menuItems, images, count: images.length, targetUrl }));
            } catch (error) {
              console.error("Vite API Scrape Error:", error.message);
              res.statusCode = 500;
              return res.end(JSON.stringify({ error: error.message }));
            }
          }

          // 3. 이미지 프록시 로직 (CORS 우회용)
          if (req.url?.startsWith('/api/proxy-image')) {
            let imageUrl;
            try {
              const urlObj = new URL(req.url, `http://${req.headers.host}`);
              imageUrl = urlObj.searchParams.get('url');
              if (!imageUrl) return res.end('url is required');

              console.log("Vite Proxying Image:", imageUrl);

              const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Referer': 'https://search.naver.com/', // 네이버 이미지 서버의 Referer 체크 우회
                }
              });

              res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
              res.setHeader('Access-Control-Allow-Origin', '*'); // 클라이언트 사이드 처리를 위한 명시적 허용
              return res.end(Buffer.from(response.data));
            } catch (error) {
              console.error("Vite API Proxy Error:", error.message, "| URL:", imageUrl);
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
