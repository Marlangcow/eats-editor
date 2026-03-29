import streamlit as st
import google.generativeai as genai
from PIL import Image
import os
import json
import io
import re
import requests as req_lib
from dotenv import load_dotenv
import pandas as pd
from streamlit_paste_button import paste_image_button
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

# Playwright 브라우저 설치 (Streamlit Cloud 포함 모든 환경)
import os, subprocess, sys
if "playwright_installed" not in st.session_state:
    os.system("playwright install chromium")
    st.session_state.playwright_installed = True

# Playwright 사용 가능 여부 확인
PLAYWRIGHT_AVAILABLE = False
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    pass

# ==========================================
# 1. 설정 및 초기화
# ==========================================
st.set_page_config(page_title="메뉴판 자동 분류 시스템", layout="wide")
load_dotenv()

with st.sidebar:
    st.title("설정")
    
    env_api_key = None
    try:
        env_api_key = st.secrets.get("GOOGLE_API_KEY")
    except Exception:
        pass
    if not env_api_key:
        env_api_key = os.getenv("GOOGLE_API_KEY")
    if not env_api_key:
        api_key_input = st.text_input("Google API Key", type="password")
        if api_key_input:
            env_api_key = api_key_input
            st.success("API 키 입력 완료")
        else:
            st.error("API 키가 필요합니다.")
    else:
        st.success("API 키 로드 완료")
    
    selected_model = st.selectbox(
        "모델 선택",
        ["gemini-2.5-flash-preview-05-20", "gemini-1.5-flash", "직접 입력"],
        index=0
    )
    if selected_model == "직접 입력":
        model_name = st.text_input("모델 이름", placeholder="예: gemini-1.5-pro")
    else:
        model_name = selected_model

if env_api_key:
    genai.configure(api_key=env_api_key)

# ==========================================
# 2. 네이버 메뉴 스크래핑 (Playwright 동기 방식)
# ==========================================
def scrape_naver_menu_images(url):
    """Playwright(동기)를 사용하여 네이버 플레이스 메뉴 이미지 추출"""
    place_id_match = re.search(r'place/(\d+)', url) or re.search(r'restaurant/(\d+)', url)
    if place_id_match:
        target_url = f"https://pcmap.place.naver.com/restaurant/{place_id_match.group(1)}/menu/list"
    else:
        target_url = url

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15"
        )
        page = context.new_page()
        try:
            page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
            
            for selector in [".place_section_content", ".menu_list", "._3y_Yt"]:
                try:
                    page.wait_for_selector(selector, timeout=5000)
                    break
                except:
                    continue
            
            page.evaluate("window.scrollTo(0, document.body.scrollHeight/2)")
            page.wait_for_timeout(1500)
            
            images = page.query_selector_all("img")
            srcs = []
            for img in images:
                src = img.get_attribute("src")
                if src and ("pstatic.net" in src or "naver.com" in src):
                    srcs.append(src)
            return list(dict.fromkeys(srcs))
        except Exception as e:
            st.error(f"스크래핑 오류: {e}")
            return []
        finally:
            browser.close()

# ==========================================
# 3. AI 로직
# ==========================================
def extract_menu_items_from_images(images, model_id):
    prompt = """이 메뉴판 이미지에서 메뉴 이름과 가격을 추출해서 JSON 리스트 형식으로만 답변해줘.
    형식: [{"이름": "메뉴명", "가격": "가격"}]
    반드시 JSON 데이터만 출력해."""
    try:
        model = genai.GenerativeModel(model_id)
        processed = []
        for img in images:
            if img is None or not hasattr(img, 'save'):
                continue
            if getattr(img, 'format', None) is None:
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                buf.seek(0)
                processed.append(Image.open(buf))
            else:
                processed.append(img)
        
        if not processed:
            st.error("유효한 이미지가 없습니다.")
            return pd.DataFrame()
        
        response = model.generate_content([prompt] + processed)
        text = response.text
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "[" in text:
            text = text[text.find("["):text.rfind("]")+1]
        return pd.DataFrame(json.loads(text))
    except Exception as e:
        st.error(f"메뉴 분석 실패: {e}")
        return pd.DataFrame()

def classify_food(food_image, menu_list, model_id):
    menu_str = ", ".join(menu_list)
    prompt = f"다음 메뉴 중 이 사진과 가장 잘 어울리는 메뉴 하나만 골라줘: [{menu_str}]. 없으면 'Others'."
    try:
        if food_image is None:
            return "Others"
        if getattr(food_image, 'format', None) is None:
            buf = io.BytesIO()
            food_image.save(buf, format="PNG")
            buf.seek(0)
            food_image = Image.open(buf)
        model = genai.GenerativeModel(model_id)
        response = model.generate_content([prompt, food_image])
        result = response.text.strip()
        for menu in menu_list:
            if menu in result:
                return menu
        return "Others"
    except:
        return "Others"

# ==========================================
# 4. UI
# ==========================================
st.title("메뉴판 자동 분류 시스템")

if 'menu_df' not in st.session_state:
    st.session_state.menu_df = pd.DataFrame()
if 'menu_images' not in st.session_state:
    st.session_state.menu_images = []

store_name = st.text_input("1. 스토어명", placeholder="예: 맛나식당_본점")
st.markdown("---")

st.subheader("2. 메뉴판 불러오기")
tab1, tab2 = st.tabs(["네이버 메뉴 주소", "이미지 붙여넣기"])

with tab1:
    naver_url = st.text_input("네이버 플레이스 URL", placeholder="https://map.naver.com/...")
    
    if not PLAYWRIGHT_AVAILABLE:
        st.info("현재 환경에서는 네이버 스크래핑을 사용할 수 없습니다. '이미지 붙여넣기' 탭을 이용해주세요.")
    
    if st.button("메뉴 불러오기", disabled=not PLAYWRIGHT_AVAILABLE) and naver_url:
        with st.spinner("네이버에서 메뉴 이미지를 가져오는 중..."):
            urls = scrape_naver_menu_images(naver_url)
            if urls:
                new_images = []
                for u in urls[:10]:
                    try:
                        resp = req_lib.get(u, stream=True, timeout=10)
                        new_images.append(Image.open(resp.raw))
                    except:
                        pass
                if new_images:
                    st.session_state.menu_images = new_images
                    st.success(f"{len(new_images)}개 이미지 로드 완료")
                else:
                    st.warning("이미지 다운로드 실패")
            else:
                st.warning("이미지를 찾지 못했습니다.")

with tab2:
    pasted = paste_image_button("이미지 붙여넣기 (클릭 후 Ctrl+V)", key="paste_btn")
    if pasted and pasted.image_data:
        st.session_state.menu_images = [pasted.image_data]
        st.image(pasted.image_data, caption="붙여넣은 이미지", width=300)

# 3단계: AI 분석
if st.session_state.menu_images:
    st.image(st.session_state.menu_images, width=150)
    if st.button("메뉴 데이터 추출", type="primary"):
        with st.spinner("AI 분석 중..."):
            st.session_state.menu_df = extract_menu_items_from_images(st.session_state.menu_images, model_name)
            if not st.session_state.menu_df.empty:
                st.success("메뉴 추출 완료!")

# 4단계: 결과
if not st.session_state.menu_df.empty:
    st.subheader("3. 추출된 메뉴 정보")
    st.session_state.menu_df = st.data_editor(st.session_state.menu_df, num_rows="dynamic", use_container_width=True)
    
    st.markdown("---")
    st.subheader("4. 분류할 사진 업로드")
    food_files = st.file_uploader("음식 사진 선택", type=["jpg", "jpeg", "png"], accept_multiple_files=True)

    if st.button("자동 분류 실행"):
        if not store_name:
            st.error("스토어명을 입력해주세요!")
        elif not food_files:
            st.error("사진을 선택해주세요!")
        else:
            progress = st.progress(0)
            base_path = f"./{store_name}"
            os.makedirs(base_path, exist_ok=True)
            menu_list = st.session_state.menu_df["이름"].tolist()
            results = []
            
            for i, f in enumerate(food_files):
                img = Image.open(f)
                cat = classify_food(img, menu_list, model_name)
                save_dir = os.path.join(base_path, cat)
                os.makedirs(save_dir, exist_ok=True)
                img.save(os.path.join(save_dir, f.name))
                results.append((f.name, cat))
                progress.progress((i + 1) / len(food_files))
            
            st.success(f"'{store_name}' 폴더에 분류 완료!")
            with st.expander("결과 상세"):
                st.table(pd.DataFrame(results, columns=["파일명", "분류 메뉴"]))