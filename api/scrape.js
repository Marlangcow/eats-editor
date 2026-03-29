import axios from 'axios';

export default async function handler(req, res) {
    let { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: '주소가 필요합니다.' });
    }

    try {
        // 1. URL 정규화 (플레이스 ID 추출 및 메뉴 리스트 페이지로 유도)
        const idMatch = url.match(/place\/(\d+)/) || url.match(/restaurant\/(\d+)/);
        if (idMatch) {
            url = `https://pcmap.place.naver.com/restaurant/${idMatch[1]}/menu/list`;
        }

        // 2. 네이버 페이지 접속하기
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            }
        });

        const html = response.data;

        // 3. HTML 안에서 네이버 사진 서버(pstatic) 주소 및 데이터 추출
        // 메뉴 이미지는 보통 고유한 패턴이나 JSON 데이터 안에 포함됨
        const regex = /https:\/\/(search\.pstatic\.net|ldb-phinf\.pstatic\.net)[^"'\s>\\{}]+/g;
        const matches = html.match(regex) || [];

        // 4. 중복 제거 및 필터링 (메뉴와 관련 없는 작은 아이콘 등 제외)
        const uniqueImages = [...new Set(matches)]
            .map(img => img.replace(/\\u002F/g, '/'))
            .filter(img => {
                // 너무 작은 이미지나 확실히 메뉴가 아닌 패턴 필터링
                if (img.includes('type=f30_30')) return false; 
                return true;
            });

        // 5. 모든 메뉴 이미지 반환 (제한 해제)
        res.status(200).json({ 
            images: uniqueImages,
            count: uniqueImages.length,
            targetUrl: url
        });

    } catch (error) {
        console.error("Scrape Error:", error.message);
        res.status(500).json({ error: '데이터를 가져오는 데 실패했습니다.' });
    }
}