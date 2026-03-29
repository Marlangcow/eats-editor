import React, { useState, useRef, useEffect } from 'react';
import {
  Upload, Download, RefreshCw, Wand2, CheckCircle2,
  X, Layers, ShoppingBag, Rocket, Sparkles, Search,
  Settings, ImagePlus, Database, ShieldCheck, Link, AlertCircle, Info, ExternalLink, PlusCircle
} from 'lucide-react';

// Firebase 연동
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, listAll } from 'firebase/storage';

/**
 * [환경 설정 안전 로직]
 * 로컬 PC(.env)와 Canvas 미리보기 환경 모두를 지원합니다.
 */
let firebaseConfig = null;
let currentAppId = 'default-app-id';

const getEnv = (key) => {
  try {
    // Vite 환경 변수 접근
    return import.meta.env[key];
  } catch (e) {
    return undefined;
  }
};

// 1. Canvas 미리보기 환경 체크 (우선순위 1)
if (typeof __firebase_config !== 'undefined') {
  try {
    firebaseConfig = JSON.parse(__firebase_config);
    currentAppId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
  } catch (e) {
    console.error("Canvas config parse error");
  }
}

// 2. 로컬 Vite 환경 (.env) 체크
if (!firebaseConfig) {
  firebaseConfig = {
    apiKey: getEnv('VITE_FIREBASE_API_KEY'),
    authDomain: getEnv('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: getEnv('VITE_FIREBASE_PROJECT_ID'),
    storageBucket: getEnv('VITE_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: getEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
    appId: getEnv('VITE_FIREBASE_APP_ID')
  };
  currentAppId = firebaseConfig.projectId || 'default-app-id';
}

// Firebase 초기화
const isConfigValid = !!(firebaseConfig && firebaseConfig.apiKey);
const app = isConfigValid ? (getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
const storage = app ? getStorage(app) : null;

// --- 알림(Toast) 컴포넌트 ---
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(() => onClose(), 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bgColors = {
    success: 'bg-[#03C75A]',
    error: 'bg-red-500',
    info: 'bg-[#00AEEF]'
  };

  const Icon = type === 'success' ? CheckCircle2 : type === 'error' ? AlertCircle : Info;

  return (
    <div className={`${bgColors[type]} text-white px-5 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-in slide-in-from-right-10 fade-in duration-300 pointer-events-auto border border-white/10`}>
      <Icon size={20} />
      <span className="font-bold text-sm leading-tight">{message}</span>
      <button onClick={onClose} className="ml-2 hover:text-white/60 transition-colors">
        <X size={16} />
      </button>
    </div>
  );
};

const App = () => {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState('owner');
  const [library, setLibrary] = useState([]);
  const [logoError, setLogoError] = useState(false);
  const [authError, setAuthError] = useState(null);

  const retoucherInputRef = useRef(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadComplete, setUploadComplete] = useState(false);

  const pendingWorkspaceCount = useRef(0);
  const workspaceToastTimer = useRef(null);
  const showWorkspaceToast = () => {
    pendingWorkspaceCount.current += 1;
    clearTimeout(workspaceToastTimer.current);
    workspaceToastTimer.current = setTimeout(() => {
      addToast(`작업 공간에 ${pendingWorkspaceCount.current}개가 추가됨`, 'success');
      pendingWorkspaceCount.current = 0;
    }, 300);
  };

  const [images, setImages] = useState([]);
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [recommendedImages, setRecommendedImages] = useState([]);
  const ownerInputRef = useRef(null);
  const [enlargedImage, setEnlargedImage] = useState(null);

  const [naverUrl, setNaverUrl] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeStep, setScrapeStep] = useState('');
  const [toasts, setToasts] = useState([]);

  const addToast = (message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // 1. 인증 시작
  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        setAuthError(error.code || error.message);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // 2. 라이브러리 실시간 동기화
  useEffect(() => {
    if (!user || !db) return;
    const storagePath = `artifacts/${currentAppId}/public/data/dummy_images`;
    const dummyRef = collection(db, 'artifacts', currentAppId, 'public', 'data', 'dummy_images');

    const loadFromStorage = async () => {
      if (!storage) return;
      try {
        const storageRef = ref(storage, storagePath);
        const result = await listAll(storageRef);
        const items = await Promise.all(result.items.map(async (itemRef) => {
          const url = await getDownloadURL(itemRef);
          // 타임스탬프 prefix 제거 후 확장자 제거
          const rawName = itemRef.name.replace(/^\d+_/, '');
          const name = rawName.split('.')[0].normalize('NFC');
          return { id: itemRef.name, name, url, createdAt: '' };
        }));
        setLibrary(items);
      } catch (e) {
        console.error('Storage listAll 실패:', e);
      }
    };

    const unsubscribe = onSnapshot(dummyRef, (snapshot) => {
      if (snapshot.empty) {
        // Firestore에 문서 없으면 Storage 직접 조회
        loadFromStorage();
      } else {
        const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        setLibrary(items);
      }
    }, (error) => {
      console.error("Firestore Load Error:", error);
      loadFromStorage(); // Firestore 오류 시도 Storage fallback
    });
    return () => unsubscribe();
  }, [user]);

  // 3. 검색 기능 — 일치하는 항목 상단, 나머지 전체 노출
  useEffect(() => {
    if (searchQuery.trim() === '') {
      setRecommendedImages([]);
      return;
    }
    const q = searchQuery.trim().toLowerCase().normalize('NFC');
    const matched = library.filter(item => (item.name || '').toLowerCase().normalize('NFC').includes(q));
    const rest = library.filter(item => !(item.name || '').toLowerCase().normalize('NFC').includes(q));
    setRecommendedImages([...matched, ...rest]);
  }, [searchQuery, library]);

  const handleNaverScrape = async () => {
    if (!naverUrl) { addToast('주소를 입력해 주세요.', 'error'); return; }
    setIsScraping(true);
    setScrapeStep('데이터 추출 중...');
    setImages([]);
    try {
      const response = await fetch(`/api/scrape?url=${encodeURIComponent(naverUrl)}`);
      const data = await response.json();

      if (data.menuItems && data.menuItems.length > 0) {
        data.menuItems.forEach(item => {
          if (!item.imageUrl) return;
          const proxiedUrl = item.imageUrl.includes('pstatic.net')
            ? `/api/proxy-image?url=${encodeURIComponent(item.imageUrl)}`
            : item.imageUrl;
          addToOwnerWorkspace(item.name || '[네이버] 메뉴', proxiedUrl, false, {
            description: item.description,
            price: item.price
          });
        });
        addToast(`${data.menuItems.length}개의 메뉴를 가져왔습니다.`, 'success');
      } else if (data.images && data.images.length > 0) {
        data.images.forEach((url, i) => {
          const proxiedUrl = url.includes('pstatic.net') ? `/api/proxy-image?url=${encodeURIComponent(url)}` : url;
          addToOwnerWorkspace(`[네이버] 메뉴 ${i + 1}`, proxiedUrl);
        });
        addToast(`${data.images.length}개의 메뉴 사진을 가져왔습니다.`, 'success');
      } else {
        addToast('메뉴 이미지를 찾지 못했습니다. 주소를 확인해 주세요.', 'error');
      }
    } catch (e) {
      addToast('서버 연결이 필요합니다. 샘플 데이터를 불러옵니다.', 'info');
      addToOwnerWorkspace('샘플 커피', 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?q=80&w=1000');
    } finally {
      setIsScraping(false);
      setNaverUrl('');
      setScrapeStep('');
    }
  };

  const handleRetoucherUpload = async (e) => {
    if (!user || !storage || !db) return;
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setIsUploading(true);
    setUploadComplete(false);
    let completedCount = 0;

    try {
      const uploadTasks = files.map(async (file) => {
        try {
          const filePath = `artifacts/${currentAppId}/public/data/dummy_images/${Date.now()}_${file.name}`;
          const sRef = ref(storage, filePath);
          await uploadBytes(sRef, file);
          const url = await getDownloadURL(sRef);
          const cleanName = file.name.split('.')[0].normalize('NFC');
          await addDoc(collection(db, 'artifacts', currentAppId, 'public', 'data', 'dummy_images'), {
            name: cleanName,
            tags: [cleanName],
            url,
            createdAt: new Date().toISOString()
          });
          completedCount++;
          setUploadProgress(Math.round((completedCount / files.length) * 100));
        } catch (err) {
          console.error("Upload error for file:", file.name, err);
          addToast(`${file.name} 업로드 실패`, 'error');
        }
      });

      await Promise.all(uploadTasks);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      if (completedCount > 0) {
        setUploadComplete(true);
        addToast(`${completedCount}장 업로드 완료`, 'success');
        setTimeout(() => setUploadComplete(false), 3000);
      }
    }
  };

  const addToOwnerWorkspace = (name, url, isBase64 = false, meta = {}) => {
    const id = crypto.randomUUID();
    const newItem = { id, name, sourceUrl: url, status: 'idle', description: meta.description || '', price: meta.price || '' };
    if (isBase64) {
      newItem.base64 = url.split(',')[1];
      setImages(prev => [newItem, ...prev]);
    } else {
      // 먼저 작업 공간에 추가하고, base64는 비동기로 채움
      setImages(prev => [newItem, ...prev]);
      fetch(url).then(r => r.blob()).then(b => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setImages(prev => prev.map(img =>
            img.id === id ? { ...img, base64: reader.result.split(',')[1] } : img
          ));
          showWorkspaceToast();
        };
        reader.readAsDataURL(b);
      }).catch(() => {
        setImages(prev => prev.filter(img => img.id !== id));
        addToast('이미지를 불러올 수 없습니다.', 'error');
      });
    }
  };

  const handleOwnerDirectUpload = (e) => {
    const files = Array.from(e.target.files);
    files.forEach(f => {
      const r = new FileReader();
      r.onloadend = () => addToOwnerWorkspace(f.name, r.result, true);
      r.readAsDataURL(f);
    });
  };

  const selectFromLibrary = (item) => {
    addToOwnerWorkspace(item.name, item.url);
    setSearchQuery('');
  };

  const processImage = async (id) => {
    const target = images.find(img => img.id === id);
    if (!target || !target.base64) return;

    updateImageStatus(id, { status: 'processing' });
    try {
      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: target.base64, mimeType: 'image/png' })
      });

      const result = await response.json();

      if (result.error) {
        const msg = result.error;
        const status = result.status;
        const code = result.code;
        console.error('[Gemini 에러]', { status, code, msg });

        if (status === 403 || code === 'PERMISSION_DENIED' || msg.includes('leaked') || msg.includes('API key'))
          throw new Error(`API 키 오류: ${msg} → Google AI Studio에서 새 키를 발급해 주세요.`);
        if (status === 429 || code === 'RESOURCE_EXHAUSTED' || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('exhausted'))
          throw new Error('할당량이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
        throw new Error(msg);
      }

      const parts = result.candidates?.[0]?.content?.parts;
      const b64Part = parts?.find(p => p.inlineData);

      if (b64Part?.inlineData?.data) {
        updateImageStatus(id, {
          status: 'success',
          result: `data:image/png;base64,${b64Part.inlineData.data}`
        });
      } else {
        const explanation = parts?.filter(p => p.text).map(p => p.text).join(' ');
        console.warn("No image in response:", explanation);
        if (explanation?.includes("Safety") || explanation?.includes("policy")) {
          throw new Error("해당 이미지는 AI 안전 정책에 의해 보정이 제한되었습니다. 다른 사진으로 시도해 주세요.");
        }
        throw new Error("보정된 이미지를 생성하지 못했습니다.");
      }
    } catch (e) {
      console.error("AI correction error:", e);
      addToast(e.message || '보정 중 오류가 발생했습니다.', 'error');
      updateImageStatus(id, { status: 'error' });
    }
  };

  const updateImageStatus = (id, upd) => setImages(prev => prev.map(img => img.id === id ? { ...img, ...upd } : img));
  const removeImage = (id) => setImages(prev => prev.filter(img => img.id !== id));
  const downloadImage = (url, name) => {
    const a = document.createElement('a'); a.href = url; a.download = `eats_${name}.png`; a.click();
  };

  /**
   * [UI 상태별 렌더링]
   * 1. 설정 오류: .env 파일이 없거나 잘못된 경우
   * 2. 인증 오류: 파이어베이스 설정 문제
   * 3. 로딩: 데이터 불러오는 중
   * 4. 메인: 실제 서비스 화면
   */

  if (!isConfigValid) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="max-w-md w-full bg-white rounded-[2.5rem] p-10 shadow-2xl border border-slate-100">
          <AlertCircle size={64} className="text-red-500 mx-auto mb-6" />
          <h1 className="text-2xl font-black text-slate-800 mb-4 tracking-tight">연결 설정이 필요합니다</h1>
          <p className="text-slate-500 mb-8 text-sm leading-relaxed break-keep">
            프로젝트 최상단의 <code className="bg-slate-100 px-1.5 py-0.5 rounded text-red-500">.env</code> 파일에 Firebase 정보가 누락되었거나 새로고침이 필요합니다.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-black transition-all shadow-lg active:scale-95"
          >
            설정 확인 후 새로고침
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8FAFC]">
        {authError === 'auth/configuration-not-found' ? (
          <div className="max-w-md w-full bg-white rounded-[2.5rem] p-10 shadow-2xl border-t-8 border-t-red-500 animate-in zoom-in-95 duration-300">
            <AlertCircle className="mx-auto text-red-500 mb-6" size={60} />
            <h2 className="text-2xl font-black text-slate-800 mb-4">익명 로그인 비활성화</h2>
            <div className="bg-slate-50 p-5 rounded-2xl text-left border border-slate-100 mb-8">
              <p className="font-bold text-slate-700 text-sm mb-3">해결 방법:</p>
              <ol className="list-decimal ml-4 space-y-2 text-xs text-slate-500 font-medium">
                <li>Firebase Console {'>'} Authentication</li>
                <li>Sign-in method 탭 클릭</li>
                <li><strong>Anonymous (익명)</strong> '사용 설정' ON</li>
              </ol>
            </div>
            <a
              href="https://console.firebase.google.com/"
              target="_blank"
              rel="noreferrer"
              className="w-full py-4 bg-[#00AEEF] text-white rounded-2xl font-black flex items-center justify-center gap-2 hover:bg-[#0092c8] transition-all"
            >
              콘솔로 이동하기 <ExternalLink size={18} />
            </a>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <RefreshCw className="animate-spin text-[#00AEEF]" size={48} />
            <p className="text-slate-400 font-bold tracking-tight animate-pulse">서비스 연결 중...</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans relative">

      {/* 토스트 알림 */}
      <div className="fixed top-24 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
        {toasts.map(t => <Toast key={t.id} {...t} onClose={() => removeToast(t.id)} />)}
      </div>

      {/* 상단 네비게이션 */}
      <nav className="bg-white/80 backdrop-blur-md border-b border-slate-200 px-6 py-4 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2 group cursor-pointer" onClick={() => window.location.reload()}>
            {!logoError ? (
              <img src="image_e04c7f.png" alt="쿠팡이츠" className="h-7 md:h-9 object-contain" onError={() => setLogoError(true)} />
            ) : (
              <span className="text-xl font-black text-[#00AEEF]">COUPANG EATS</span>
            )}
            <span className="text-xl font-black text-[#00AEEF] ml-0.5">PRO</span>
          </div>

          <div className="flex bg-slate-100 p-1.5 rounded-2xl border border-slate-200 shadow-inner">
            <button
              onClick={() => setRole('owner')}
              className={`px-6 py-2.5 rounded-xl text-sm font-black transition-all duration-300 flex items-center gap-2 ${role === 'owner' ? 'bg-white text-[#00AEEF] shadow-md scale-105' : 'text-slate-500 hover:text-slate-700'
                }`}
            >
              <ShoppingBag size={16} /> 사장님
            </button>
            <button
              onClick={() => setRole('retoucher')}
              className={`px-6 py-2.5 rounded-xl text-sm font-black transition-all duration-300 flex items-center gap-2 ${role === 'retoucher' ? 'bg-slate-800 text-white shadow-md scale-105' : 'text-slate-500 hover:text-slate-700'
                }`}
            >
              <Settings size={16} /> 리터쳐
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-12">
        {role === 'retoucher' ? (
          <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="bg-white rounded-[3rem] p-12 border border-slate-200 shadow-xl text-center relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-full h-2 bg-slate-800"></div>
              <Database className="mx-auto text-slate-200 mb-6 group-hover:text-slate-800 transition-colors" size={60} />
              <div className="flex flex-col items-center space-y-4 mb-10 text-center">
                <h2 className="text-3xl font-black text-slate-800 tracking-tight">공용 라이브러리 구축</h2>
                <p className="text-slate-400 max-w-lg mx-auto font-medium leading-relaxed text-center">
                  여러 장의 사진을 한 번에 올려 사장님들이 검색할 수 있는 보관소를 만듭니다.
                </p>
                {isUploading && (
                  <div className="flex flex-col items-center gap-2 mt-4 animate-in fade-in zoom-in-95 duration-300">
                    <span className="text-[#00AEEF] font-black text-lg">업로드 중 {uploadProgress}%</span>
                    <div className="w-64 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-[#00AEEF] transition-all duration-300" style={{ width: `${uploadProgress}%` }}></div>
                    </div>
                  </div>
                )}
              </div>
              <input type="file" ref={retoucherInputRef} onChange={handleRetoucherUpload} multiple accept="image/*" className="hidden" />
              <button
                onClick={() => retoucherInputRef.current?.click()}
                disabled={isUploading}
                className={`px-10 py-5 rounded-[1.5rem] font-black flex items-center gap-3 mx-auto transition-all shadow-xl active:scale-95 ${isUploading ? 'bg-slate-100 text-slate-400 cursor-not-allowed' :
                  uploadComplete ? 'bg-[#03C75A] text-white scale-105' :
                    'bg-slate-900 text-white hover:bg-black hover:scale-105'
                  }`}
              >
                {isUploading ? (
                  <><RefreshCw className="animate-spin" size={24} /> 업로드 중...</>
                ) : uploadComplete ? (
                  <><CheckCircle2 size={24} /> 업로드 완료!</>
                ) : (
                  <><ImagePlus size={24} /> 사진 묶음 등록하기</>
                )}
              </button>
            </div>

            <div className="space-y-6">
              <h3 className="text-xl font-black flex items-center gap-2 px-2">
                <ShieldCheck className="text-[#03C75A]" size={24} />
                전체 보관소 목록 ({library.length})
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                {library.map(item => (
                  <div key={item.id} className="aspect-square bg-white rounded-3xl border border-slate-200 overflow-hidden relative group shadow-sm hover:shadow-xl transition-all hover:-translate-y-1">
                    <img src={item.url} className="w-full h-full object-cover" alt="" />
                    <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center p-3 transition-opacity">
                      <span className="text-white text-[11px] font-bold text-center leading-tight">{item.name}</span>
                    </div>
                  </div>
                ))}
                {library.length === 0 && <div className="col-span-full py-20 text-center text-slate-300 font-bold border-2 border-dashed border-slate-200 rounded-[2rem]">아직 등록된 사진이 없습니다.</div>}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 animate-in fade-in slide-in-from-bottom-4 duration-700">

            {/* 사이드바 메뉴 */}
            <div className="lg:col-span-4 space-y-6">
              <div className="bg-white rounded-[2.5rem] p-8 border border-slate-200 shadow-sm space-y-8">
                <section>
                  <h2 className="text-lg font-black flex items-center gap-2 mb-4 text-[#03C75A]">
                    <Link size={22} /> 네이버 연동
                  </h2>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="플레이스 주소 입력"
                      value={naverUrl}
                      onChange={e => setNaverUrl(e.target.value)}
                      className="flex-1 px-5 py-4 bg-slate-50 rounded-2xl border-none text-sm font-bold focus:ring-2 focus:ring-[#03C75A]/20 transition-all"
                    />
                    <button
                      onClick={handleNaverScrape}
                      disabled={isScraping || !naverUrl}
                      className="p-4 bg-[#03C75A] text-white rounded-2xl hover:bg-[#02a84c] transition-all shadow-md active:scale-90 disabled:bg-slate-200"
                    >
                      {isScraping ? <RefreshCw className="animate-spin" /> : <Download />}
                    </button>
                  </div>
                </section>

                <section>
                  <h2 className="text-lg font-black flex items-center gap-2 mb-4 text-[#00AEEF]">
                    <Search size={22} /> 메뉴 검색
                  </h2>
                  <input
                    type="text"
                    placeholder="돈가스, 커피, 치킨..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full px-5 py-4 bg-slate-50 rounded-2xl border-none text-sm font-bold focus:ring-2 focus:ring-[#00AEEF]/20 transition-all mb-4"
                  />
                  <div className="grid grid-cols-2 gap-3 max-h-72 overflow-y-auto pr-1">
                    {recommendedImages.map(item => (
                      <button
                        key={item.id}
                        onClick={() => selectFromLibrary(item)}
                        className="aspect-square rounded-2xl overflow-hidden border-4 border-transparent hover:border-[#00AEEF] transition-all shadow-sm group relative"
                      >
                        <img src={item.url} className="w-full h-full object-cover" alt="" />
                        <div className="absolute inset-0 bg-[#00AEEF]/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-all">
                          <PlusCircle className="text-white" size={24} />
                        </div>
                      </button>
                    ))}
                    {searchQuery && library.length === 0 && (
                      <p className="col-span-2 py-8 text-center text-slate-400 text-xs font-bold">라이브러리에 등록된 사진이 없어요.</p>
                    )}
                  </div>
                </section>

                <div
                  onClick={() => ownerInputRef.current?.click()}
                  className="bg-slate-50 rounded-[2rem] p-10 border-2 border-dashed border-slate-200 text-center cursor-pointer hover:bg-white hover:border-[#00AEEF] hover:shadow-xl transition-all group"
                >
                  <Upload className="mx-auto text-slate-300 group-hover:text-[#00AEEF] mb-3 transition-colors" size={36} />
                  <p className="text-sm font-black text-slate-600">내 PC에서 사진 올리기</p>
                  <input type="file" ref={ownerInputRef} onChange={handleOwnerDirectUpload} multiple className="hidden" />
                </div>
              </div>
            </div>

            {/* 메인 작업 리스트 */}
            <div className="lg:col-span-8 space-y-6">
              <div className="flex justify-between items-center px-4">
                <h2 className="text-2xl font-black flex items-center gap-3">
                  <Layers className="text-[#00AEEF]" size={28} /> 작업 공간
                </h2>
                {images.length > 0 && (
                  <button
                    onClick={() => images.forEach(i => processImage(i.id))}
                    className="px-8 py-4 bg-[#00AEEF] text-white rounded-[1.25rem] font-black shadow-xl hover:bg-[#0092c8] hover:scale-105 transition-all flex items-center gap-2 active:scale-95"
                  >
                    <Sparkles size={20} /> 프리미엄 보정 시작
                  </button>
                )}
              </div>

              <div className="space-y-6">
                {images.map(img => (
                  <div key={img.id} className="bg-white rounded-[2.5rem] border border-slate-200 overflow-hidden flex flex-col md:flex-row h-auto md:h-52 shadow-md hover:shadow-2xl transition-all group/card border-b-8 border-b-slate-100">
                    <div className="w-full md:w-72 h-52 md:h-full bg-slate-100 relative shrink-0">
                      <img src={img.sourceUrl} className="w-full h-full object-cover opacity-50" alt="" />
                      <div className="absolute top-5 left-5 bg-black/60 text-white text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-tighter shadow-lg">Original</div>
                      {img.status === 'idle' && (
                        <button
                          onClick={() => processImage(img.id)}
                          className="absolute inset-0 m-auto w-14 h-14 bg-white text-[#00AEEF] rounded-2xl shadow-2xl flex items-center justify-center hover:scale-110 active:scale-90 transition-all"
                        >
                          <Wand2 size={28} />
                        </button>
                      )}
                    </div>

                    <div className="flex-1 bg-white flex flex-col h-52 md:h-full relative overflow-hidden">
                      {img.status === 'processing' ? (
                        <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-sky-50/50">
                          <RefreshCw className="animate-spin text-[#00AEEF]" size={40} />
                          <span className="text-xs font-black text-[#00AEEF] animate-pulse">AI 리터칭 진행 중...</span>
                        </div>
                      ) : img.result ? (
                        <div className="flex-1 cursor-zoom-in group/result" onClick={() => setEnlargedImage(img.result)}>
                          <img src={img.result} className="w-full h-full object-cover" alt="" />
                          <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/result:opacity-100 transition-opacity flex items-center justify-center">
                            <div className="flex gap-4">
                              <button
                                onClick={e => { e.stopPropagation(); downloadImage(img.result, img.name); }}
                                className="p-4 bg-white text-[#00AEEF] rounded-full shadow-2xl hover:scale-110 active:scale-90 transition-all"
                              >
                                <Download size={24} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-slate-100">
                          <Sparkles size={60} />
                        </div>
                      )}

                      <div className="absolute top-5 right-5 z-10">
                        <button onClick={() => removeImage(img.id)} className="p-2 bg-white/80 backdrop-blur-md rounded-full text-slate-400 hover:text-red-500 hover:bg-white shadow-sm transition-all">
                          <X size={20} />
                        </button>
                      </div>

                      <div className="p-5 bg-white border-t border-slate-100 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-black text-slate-800 truncate leading-none mb-1">{img.name}</p>
                          {img.description && <p className="text-[11px] text-slate-400 truncate mb-0.5">{img.description}</p>}
                          {img.price
                            ? <p className="text-[12px] font-black text-[#00AEEF]">{img.price}</p>
                            : <p className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">Premium Upscale</p>
                          }
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {images.length === 0 && (
                  <div className="h-80 flex flex-col items-center justify-center text-slate-200 bg-white border-4 border-dashed border-slate-100 rounded-[3rem] shadow-inner">
                    <ShoppingBag size={64} className="mb-6 opacity-5" />
                    <p className="font-black text-xl opacity-20 tracking-tighter">작업 리스트가 비어있습니다.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 전체화면 확대 */}
      {enlargedImage && (
        <div className="fixed inset-0 z-[200] bg-slate-900/95 flex items-center justify-center p-6 backdrop-blur-xl animate-in fade-in duration-300" onClick={() => setEnlargedImage(null)}>
          <div className="relative max-w-6xl w-full h-full flex flex-col items-center justify-center">
            <img src={enlargedImage} className="max-w-full max-h-[85vh] object-contain rounded-[2rem] shadow-[0_0_100px_rgba(0,174,239,0.3)] animate-in zoom-in-95 duration-500" alt="" />
            <div className="mt-8 flex gap-4">
              <button className="px-8 py-4 bg-white text-slate-900 rounded-2xl font-black shadow-xl" onClick={() => setEnlargedImage(null)}>닫기</button>
              <button
                className="px-8 py-4 bg-[#00AEEF] text-white rounded-2xl font-black shadow-xl flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  downloadImage(enlargedImage, 'download');
                }}
              >
                <Download size={20} /> 다운로드
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 푸터 */}
      <footer className="py-20 text-center border-t border-slate-200 mt-20">
        <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em]">Coupang Eats Pro Editor Service Layer</p>
      </footer>
    </div>
  );
};

export default App;