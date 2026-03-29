import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import axios from 'axios'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
const env = loadEnv(mode, process.cwd(), '');
return {
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

              const desktopHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'ko-KR,ko;q=0.9',
                'Referer': `https://map.naver.com/`,
              };
              const mobileHeaders = {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept-Language': 'ko-KR,ko;q=0.9',
                'Referer': `https://m.place.naver.com/restaurant/${placeId}/menu/list`,
              };

              let menuItems = [];

              // 메뉴 아이템 객체에서 이미지 URL 추출 (다양한 필드명 대응)
              const extractImageUrl = (m) =>
                m.images?.[0]?.url || m.image?.[0]?.url ||
                m.representativeImages?.[0]?.url || m.thumbnailImages?.[0]?.url ||
                m.imageUrl || m.photo || m.thumbnailUrl || m.imgUrl || '';

              // 메뉴 아이템 배열인지 판별 — name + (price or description) 있으면 메뉴로 간주
              const isMenuArray = (arr) =>
                arr.length > 0 && arr[0]?.name != null &&
                (arr[0]?.price != null || arr[0]?.description != null || arr[0]?.desc != null);

              const toMenuItem = (m) => ({
                name: m.name || m.menuName || '',
                description: m.description || m.desc || m.content || '',
                price: m.price != null ? String(m.price) : '',
                imageUrl: extractImageUrl(m)
              });

              // __NEXT_DATA__ 재귀 탐색
              const findMenusInJson = (obj, depth = 0) => {
                if (!obj || typeof obj !== 'object' || depth > 20) return null;
                if (Array.isArray(obj)) {
                  if (isMenuArray(obj)) return obj.map(toMenuItem);
                  for (const el of obj) { const r = findMenusInJson(el, depth+1); if (r) return r; }
                  return null;
                }
                for (const key of Object.keys(obj)) {
                  if (/menu/i.test(key) && Array.isArray(obj[key]) && isMenuArray(obj[key])) {
                    console.log(`[JSON] key="${key}" ${obj[key].length}개, sample:`, JSON.stringify(obj[key][0]).slice(0, 150));
                    return obj[key].map(toMenuItem);
                  }
                  const r = findMenusInJson(obj[key], depth+1);
                  if (r) return r;
                }
                return null;
              };

              // pstatic 이미지 URL 정규화
              const normImg = (u) => u.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&');
              const isMenuImg = (u) => !u.includes('f30_30') && !u.includes('ico');

              // HTML에서 메뉴 추출:
              // 1) HZmgf 컨테이너 단위 (이름+설명+가격+이미지 개별 매핑)
              // 2) 컨테이너 없으면 lPzHi 위치 기준으로 근접 이미지 매핑
              const extractFromHtml = (html, label) => {
                let processHtml = html;
                const boardMatch = html.match(/메뉴판 이미지로 보기/);
                if (boardMatch) processHtml = html.slice(0, boardMatch.index);

                // 방법 1: HZmgf 컨테이너 단위 파싱
                const chunks = processHtml.split(/class="[^"]*HZmgf[^"]*"/);
                chunks.shift();
                if (chunks.length > 0) {
                  const items = chunks.map(chunk => {
                    const name  = (chunk.match(/class="lPzHi"[^>]*>([^<]+)</) || [])[1]?.trim() || '';
                    const desc  = (chunk.match(/class="okI98"[^>]*>([^<]+)</) || [])[1]?.trim() || '';
                    const price = (chunk.match(/class="p2H02"[^>]*>([^<]+)</) || [])[1]?.trim() || '';
                    const imgM  = chunk.match(/(?:src|data-src)="(https?:\/\/[^"]*pstatic\.net[^"]*)"/) ||
                                  chunk.match(/"(https:\\u002F\\u002F[^"]*pstatic[^"\\]+)"/);
                    const imageUrl = imgM ? normImg(imgM[1]) : '';
                    return { name, description: desc, price, imageUrl };
                  }).filter(i => i.name || i.imageUrl);

                  if (items.length > 0) {
                    console.log(`[${label} HZmgf] ${items.length}개`);
                    return items;
                  }
                }

                // 방법 2: lPzHi 위치 기준으로 주변에서 이미지 탐색
                const nameMatches = [...processHtml.matchAll(/class="lPzHi"[^>]*>([^<]+)</g)];
                if (nameMatches.length > 0) {
                  const allImgMatches = [...processHtml.matchAll(/(?:src|data-src)="(https?:\/\/[^"]*pstatic\.net[^"]*)"/g)]
                    .filter(m => isMenuImg(m[1]));

                  const items = nameMatches.map((nm, i) => {
                    const namePos = nm.index;
                    // 이 이름 이후 가장 가까운 이미지 찾기
                    const nextImg = allImgMatches.find(im => im.index > namePos);
                    return {
                      name: nm[1].trim(),
                      description: (processHtml.slice(namePos).match(/class="okI98"[^>]*>([^<]+)</) || [])[1]?.trim() || '',
                      price:       (processHtml.slice(namePos).match(/class="p2H02"[^>]*>([^<]+)</) || [])[1]?.trim() || '',
                      imageUrl: nextImg ? normImg(nextImg[1]) : ''
                    };
                  }).filter(i => i.name || i.imageUrl);

                  console.log(`[${label} 근접매핑] ${items.length}개`);
                  return items;
                }

                console.log(`[${label}] 추출 실패`);
                return [];
              };

              // 2. 데스크톱 HTML (pcmap — SSR에 lPzHi/okI98 포함)
              try {
                const dRes = await axios.get(
                  `https://pcmap.place.naver.com/restaurant/${placeId}/menu/list`,
                  { headers: desktopHeaders }
                );
                const dHtml = dRes.data;
                console.log(`[Desktop] HTML 길이: ${dHtml.length}`);

                // __NEXT_DATA__ JSON 우선 시도
                const ndMatch = dHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                if (ndMatch) {
                  const found = findMenusInJson(JSON.parse(ndMatch[1]));
                  if (found?.length) { menuItems = found; console.log(`[Desktop NEXT_DATA] ${menuItems.length}개`); }
                }

                // 클래스 직접 추출
                if (menuItems.length === 0) {
                  menuItems = extractFromHtml(dHtml, 'Desktop HTML');
                }
              } catch (e) { console.warn('[Desktop] 실패:', e.message); }

              // 3. 모바일 HTML fallback
              if (menuItems.length === 0) {
                try {
                  const mRes = await axios.get(
                    `https://m.place.naver.com/restaurant/${placeId}/menu/list`,
                    { headers: mobileHeaders }
                  );
                  const mHtml = mRes.data;
                  console.log(`[Mobile] HTML 길이: ${mHtml.length}`);

                  const ndMatch = mHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                  if (ndMatch) {
                    const found = findMenusInJson(JSON.parse(ndMatch[1]));
                    if (found?.length) { menuItems = found; console.log(`[Mobile NEXT_DATA] ${menuItems.length}개`); }
                  }
                  if (menuItems.length === 0) {
                    menuItems = extractFromHtml(mHtml, 'Mobile HTML');
                  }
                } catch (e) { console.warn('[Mobile] 실패:', e.message); }
              }

              // 4. GraphQL fallback
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
                    { headers: { ...desktopHeaders, 'Content-Type': 'application/json', 'Origin': 'https://pcmap.place.naver.com' } }
                  );
                  const data = gqlRes.data?.[0]?.data?.restaurant;
                  const menus = data?.menuList || data?.menus;
                  if (menus?.length) {
                    menuItems = menus.map(m => ({ name: m.name||'', description: m.description||'', price: m.price!=null?String(m.price):'', imageUrl: m.images?.[0]?.url||'' }));
                    console.log(`[GQL] ${menuItems.length}개`);
                  } else {
                    console.warn('[GQL] 응답:', JSON.stringify(gqlRes.data).slice(0, 200));
                  }
                } catch (e) { console.warn('[GQL] 실패:', e.message); }
              }

              console.log(`[Scrape 완료] ${menuItems.length}개\n`);
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
          // 4. Gemini 이미지 생성 프록시 (API 키 서버에서만 사용)
          if (req.url?.startsWith('/api/gemini')) {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
              try {
                const { base64, mimeType } = JSON.parse(body);
                const geminiApiKey = env.VITE_GEMINI_API_KEY || env.VITE_GOOGLE_API_KEY;
                if (!geminiApiKey) {
                  res.statusCode = 500;
                  return res.end(JSON.stringify({ error: 'VITE_GEMINI_API_KEY가 설정되지 않았습니다.' }));
                }

                // 사용 가능한 이미지 생성 모델 조회
                const modelsRes = await axios.get(
                  `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`
                );
                if (modelsRes.data.error) {
                  res.statusCode = 400;
                  return res.end(JSON.stringify({ error: modelsRes.data.error.message }));
                }
                const models = modelsRes.data.models || [];
                const imageModel = models.find(m =>
                  m.supportedGenerationMethods?.includes('generateContent') &&
                  /imagen|flash.*image|image.*gen/i.test(m.name)
                );
                if (!imageModel) {
                  res.statusCode = 400;
                  return res.end(JSON.stringify({ error: '이미지 생성 모델을 찾을 수 없습니다.' }));
                }
                const modelName = imageModel.name.replace(/^models\//, '');
                console.log(`[Gemini] 사용 모델: ${modelName}`);

                const PROMPT = `
                  Task: High-Conversion Food Photography for Coupang Eats
                  1. Formatting: Exact 1080x660 pixels. Central food framing (80% focus).
                  2. Aesthetic: Premium 'Elegant Beige' background. Zero environmental noise.
                  3. Components: Synthesis of an ultra-high-quality ceramic plate. 45-degree angle.
                  4. Texture: Enhance steam, gloss, and crispness. Professional soft-box lighting.
                  5. Outpainting: Naturally expand cut-off parts of food/plate to create a full, satisfying view.

                  Guide:
                  - Appetizing Color: Adjust saturation and brightness slightly to highlight the freshness of raw materials.
                  - Depth & Shadow: Adding a natural floor shadow so the food doesn't float on the beige background.
                  - Custom Style: Choose optimized plates and compositions according to menu types (Korean, Western, dessert, etc.).
                  - 70% Rule: Arrange food to occupy about 70-80% of the screen so that food looks best in the delivery app list.
                `;

                const gRes = await axios.post(
                  `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`,
                  {
                    contents: [{
                      parts: [
                        { text: PROMPT },
                        { inlineData: { mimeType: mimeType || 'image/png', data: base64 } }
                      ]
                    }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
                  },
                  { headers: { 'Content-Type': 'application/json' } }
                );

                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify(gRes.data));
              } catch (e) {
                const status = e.response?.status;
                const apiError = e.response?.data?.error;
                console.error(`[Gemini] 에러 (HTTP ${status}):`, apiError || e.message);
                res.statusCode = status || 500;
                return res.end(JSON.stringify({
                  error: apiError?.message || e.message,
                  status: status,
                  code: apiError?.code || apiError?.status
                }));
              }
            });
            return;
          }

          next();
        });
      }
    }
  ],
}
})