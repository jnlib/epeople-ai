// ═══════════════════════════════════════════════════════════════
// 국민신문고 민원답변 생성기 v2
// Gemini 2.5 Flash-Lite + 법제처 DRF API 통합
// ═══════════════════════════════════════════════════════════════

import {
  CODE_CHECKS,
  AI_DEDUCTIONS,
  COOPERATION_CHECKLIST,
  SINCERITY_BASE,
  RUBRIC_VERSION,
} from './rubric.js';

// ─────────────────────────────────────────────
// 보안: 허용된 Origin만 접근 가능 (Gemini 키 남용 방지)
// ─────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://jnlib.github.io',
  'http://localhost:8000',
  'http://localhost:5500',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:5500',
];

function getCors(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Origin 없을 수 있는 same-origin fetch의 Referer 폴백
  return ALLOWED_ORIGINS.some((a) => referer.startsWith(a + '/'));
}

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const LAW_OC = 'hdh1231';
const LAW_BASE = 'https://www.law.go.kr/DRF';

// ─────────────────────────────────────────────
// 간이 레이트 리밋 (IP당 분당 20회)
// ─────────────────────────────────────────────
const rateBucket = new Map();
function checkRateLimit(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const maxReq = 20;

  let entry = rateBucket.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    rateBucket.set(ip, entry);
  }
  entry.count++;
  // 오래된 항목 정리 (메모리 제한)
  if (rateBucket.size > 500) {
    for (const [k, v] of rateBucket) {
      if (now - v.start > windowMs * 2) rateBucket.delete(k);
    }
  }
  return entry.count <= maxReq;
}

export default {
  async fetch(request, env) {
    const cors = getCors(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 헬스체크는 어디서든 가능
      if (path === '/api/health') {
        return json(
          {
            status: 'ok',
            service: 'epeople-ai-v2',
            version: RUBRIC_VERSION,
            geminiKey: !!env.GEMINI_API_KEY,
          },
          200,
          cors,
        );
      }

      // 나머지 모든 API는 허용된 origin에서만
      if (!isAllowedOrigin(request)) {
        return json({ error: 'Forbidden origin' }, 403, cors);
      }

      // Gemini 쓰는 엔드포인트에 레이트 리밋
      if (path === '/api/propose' || path === '/api/generate-draft' || path === '/api/evaluate-edit') {
        if (!checkRateLimit(request)) {
          return json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429, cors);
        }
      }

      if (path === '/api/propose' && request.method === 'POST') {
        const body = await request.json();
        return await handlePropose(body, env, cors);
      }

      if (path === '/api/generate-draft' && request.method === 'POST') {
        const body = await request.json();
        return await handleGenerateDraft(body, env, cors);
      }

      if (path === '/api/evaluate-edit' && request.method === 'POST') {
        const body = await request.json();
        return await handleEvaluateEdit(body, env, cors);
      }

      return json({ error: 'Not Found' }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || 'Server error' }, 500, cors);
    }
  },
};

// ─────────────────────────────────────────────
// 공통: JSON 응답
// ─────────────────────────────────────────────
function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

// ─────────────────────────────────────────────
// Gemini Flash-Lite 호출 (공통)
// ─────────────────────────────────────────────
async function callGemini(apiKey, prompt, schema, temperature = 0.1) {
  if (!apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };
  if (schema) body.generationConfig.responseSchema = schema;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw) throw new Error('Gemini 빈 응답');

  try {
    return JSON.parse(raw);
  } catch (e) {
    // JSON 파싱 실패 시 첫 { ... } 블록 추출
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Gemini JSON 파싱 실패: ' + raw.slice(0, 200));
  }
}

// ─────────────────────────────────────────────
// 법제처 API 호출
// ─────────────────────────────────────────────
// 법제처 응답이 JSON인지 안전하게 확인
function safeParseLaw(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
}

// 법제처 fetch with retry — 병렬 호출 시 개별 재시도
async function lawFetchWithRetry(url, timeoutMs = 10000, maxRetries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; EpeopleBot/1.0)',
          'Accept': 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(timeoutMs),
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      const text = await res.text();
      if (
        text.includes('error code: 525') ||
        text.includes('<!DOCTYPE') ||
        text.includes('error500') ||
        text.includes('미신청')
      ) {
        lastErr = new Error('법제처 응답 오류: ' + text.slice(0, 80));
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 200 + attempt * 150));
          continue;
        }
        return null;
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 200 + attempt * 150));
        continue;
      }
    }
  }
  console.log('lawFetch 실패:', url.slice(0, 80), '-', lastErr?.message);
  return null;
}

async function fetchEflawByName(name, cache) {
  const cacheKey = `eflaw:${name}`;
  if (cache) {
    const cached = await cache.match(new Request(`https://cache/${encodeURIComponent(cacheKey)}`));
    if (cached) return await cached.json();
  }

  const qs = new URLSearchParams({
    OC: LAW_OC, target: 'eflaw', type: 'JSON',
    query: name, search: '1', nw: '3', display: '5',
  });
  const text = await lawFetchWithRetry(`${LAW_BASE}/lawSearch.do?${qs}`);
  const data = safeParseLaw(text);
  if (!data) return { totalCnt: '0', law: [] };
  const result = data.LawSearch || { totalCnt: '0', law: [] };

  if (cache) {
    const response = new Response(JSON.stringify(result), {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
    await cache.put(new Request(`https://cache/${encodeURIComponent(cacheKey)}`), response);
  }
  return result;
}

async function fetchAiSearch(query, cache) {
  const cacheKey = `aisearch:${query}`;
  if (cache) {
    const cached = await cache.match(new Request(`https://cache/${encodeURIComponent(cacheKey)}`));
    if (cached) return await cached.json();
  }

  const qs = new URLSearchParams({
    OC: LAW_OC, target: 'aiSearch', type: 'JSON',
    query, search: '0', display: '10',
  });
  const text = await lawFetchWithRetry(`${LAW_BASE}/lawSearch.do?${qs}`);
  const data = safeParseLaw(text);
  if (!data) return { 법령조문: [] };
  const result = data.aiSearch || { 법령조문: [] };

  if (cache) {
    const response = new Response(JSON.stringify(result), {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
    await cache.put(new Request(`https://cache/${encodeURIComponent(cacheKey)}`), response);
  }
  return result;
}

async function fetchLawBody(lawId, cache) {
  const cacheKey = `law:${lawId}`;
  if (cache) {
    const cached = await cache.match(new Request(`https://cache/${encodeURIComponent(cacheKey)}`));
    if (cached) return await cached.json();
  }

  const qs = new URLSearchParams({
    OC: LAW_OC, target: 'law', type: 'JSON', ID: lawId,
  });
  const text = await lawFetchWithRetry(`${LAW_BASE}/lawService.do?${qs}`, 12000);
  const data = safeParseLaw(text);
  if (!data) return null;
  const law = data.법령 || null;
  if (!law) return null;

  // 필요한 필드만 파싱 (부칙·개정문·연락부서 등 제거)
  const base = law.기본정보 || {};
  const artsRaw = law.조문?.조문단위 || [];
  const articles = (Array.isArray(artsRaw) ? artsRaw : [artsRaw])
    .filter((a) => a?.조문여부 === '조문' && a?.조문제목 && a?.조문내용)
    .map((a) => ({
      no: String(a.조문번호 || '').replace(/^0+/, '') || '0',
      title: a.조문제목 || '',
      content: a.조문내용 || '',
      effectiveDate: a.조문시행일자 || '',
    }));

  const parsed = {
    lawId: base.법령ID || lawId,
    // mst(법령일련번호)는 lawService 응답에 직접 없음 — eflaw/aiSearch에서 받은 값을 상위 파이프라인에서 주입
    mst: null,
    name: base.법령명_한글 || '',
    shortName: base.법령명약칭 || '',
    kind: base.법종구분?.content || '',
    ministry: base.소관부처?.content || '',
    effectiveDate: formatYmd(base.시행일자),
    promulgationDate: formatYmd(base.공포일자),
    articles,
  };

  if (cache) {
    const response = new Response(JSON.stringify(parsed), {
      headers: { 'Cache-Control': 'public, max-age=86400' },
    });
    await cache.put(new Request(`https://cache/${encodeURIComponent(cacheKey)}`), response);
  }
  return parsed;
}

function formatYmd(raw) {
  if (!raw) return '';
  const s = String(raw).slice(0, 8);
  if (s.length !== 8) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// ─────────────────────────────────────────────
// 법령명 검증: aiSearch 1차 (안정적, 약칭 지원) → eflaw 2차 폴백
// ─────────────────────────────────────────────
async function verifyLawName(name, cache) {
  // 1차: aiSearch — 실측 결과 가장 안정적이고 약칭도 처리
  const r1 = await fetchAiSearch(name, cache);
  const items1 = Array.isArray(r1.법령조문) ? r1.법령조문 : [r1.법령조문].filter(Boolean);
  if (items1.length > 0) {
    // 같은 법령ID 중복 제거, 이름 매칭 우선
    const seen = new Set();
    const result = [];
    const nameNoSpace = name.replace(/\s+/g, '');
    // 제안한 이름과 매칭도 높은 것 우선 정렬
    const sorted = [...items1].sort((a, b) => {
      const aName = (a.법령명 || '').replace(/\s+/g, '');
      const bName = (b.법령명 || '').replace(/\s+/g, '');
      const aMatch = aName.includes(nameNoSpace) || nameNoSpace.includes(aName) ? 0 : 1;
      const bMatch = bName.includes(nameNoSpace) || nameNoSpace.includes(bName) ? 0 : 1;
      return aMatch - bMatch;
    });
    for (const it of sorted) {
      const id = it.법령ID;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push({
        lawId: id,
        mst: it.법령일련번호,
        name: it.법령명,
        shortName: '',
        kind: it.법령종류명 || '',
        ministry: it.소관부처명 || '',
        effectiveDate: formatYmd(it.시행일자),
        source: 'aiSearch',
      });
      if (result.length >= 1) break; // 가장 관련 높은 것 1개만
    }
    if (result.length > 0) return result;
  }

  // 2차 폴백: eflaw search=1 (정확 법령명 매칭)
  const r2 = await fetchEflawByName(name, cache);
  if (parseInt(r2.totalCnt || '0', 10) > 0) {
    const laws = Array.isArray(r2.law) ? r2.law : [r2.law];
    return laws.slice(0, 1).map((l) => ({
      lawId: l.법령ID,
      mst: l.법령일련번호,
      name: l.법령명한글,
      shortName: l.법령약칭명 || '',
      kind: l.법령구분명 || '',
      ministry: l.소관부처명 || '',
      effectiveDate: formatYmd(l.시행일자),
      source: 'eflaw',
    }));
  }

  return [];
}

// ─────────────────────────────────────────────
// 조문 필터링 (topics 힌트 기반)
// ─────────────────────────────────────────────
function filterArticlesByTopics(articles, topics) {
  if (!articles || articles.length === 0) return [];
  if (!topics || topics.length === 0) return articles.slice(0, 10);

  const matched = [];
  const unmatched = [];
  for (const a of articles) {
    const haystack = (a.title + ' ' + a.content.slice(0, 150)).toLowerCase();
    if (topics.some((t) => haystack.includes(String(t).toLowerCase()))) {
      matched.push(a);
    } else {
      unmatched.push(a);
    }
  }
  // 매칭 조문 우선, 부족분은 순서상 앞쪽 조문으로 채움, 총 최대 10개
  const combined = [...matched, ...unmatched.slice(0, Math.max(0, 10 - matched.length))];
  return combined.slice(0, 10);
}

// ─────────────────────────────────────────────
// /api/generate — 초안 생성 플로우
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// /api/propose — 민원 원문 → Gemini → {요지, 검색어}
// (법제처는 브라우저가 직접 호출하므로 Worker는 Gemini만 담당)
// ─────────────────────────────────────────────
async function handlePropose(body, env, cors) {
  const { text, mType } = body;
  if (!text || typeof text !== 'string') {
    return json({ error: '민원 원문이 필요합니다' }, 400, cors);
  }
  const complaint = text.slice(0, 3000);

  const proposal = await callGemini(
    env.GEMINI_API_KEY,
    buildProposalPrompt(complaint, mType),
    PROPOSAL_SCHEMA,
    0.2,
  );

  const preSummary = (proposal?.summary || '').trim();
  const issues = Array.isArray(proposal?.issues)
    ? proposal.issues.filter((i) => typeof i === 'string' && i.trim().length > 0)
    : [];
  const queries = Array.isArray(proposal?.searchQueries)
    ? proposal.searchQueries.filter((q) => typeof q === 'string' && q.trim().length > 0)
    : [];
  if (preSummary && !queries.includes(preSummary)) queries.push(preSummary);
  const isLawRelated = proposal?.isLawRelated !== false;

  return json(
    {
      summary: preSummary,
      issues,
      searchQueries: queries,
      isLawRelated,
      source: `gemini:${GEMINI_MODEL}`,
    },
    200,
    cors,
  );
}

// ─────────────────────────────────────────────
// /api/generate-draft — 민원 원문 + 법령 후보 → Gemini → 답변 초안
// 브라우저가 직접 법제처에서 수집한 후보를 전달
// ─────────────────────────────────────────────
async function handleGenerateDraft(body, env, cors) {
  const { text, mType, cooperation, candidateLaws, preSummary, issues } = body;
  if (!text || typeof text !== 'string') {
    return json({ error: '민원 원문이 필요합니다' }, 400, cors);
  }
  const complaint = text.slice(0, 3000);
  const safeCandidates = Array.isArray(candidateLaws) ? candidateLaws.slice(0, 10) : [];
  const safeIssues = Array.isArray(issues) ? issues.filter(i => typeof i === 'string' && i.trim()) : [];

  const generation = await callGemini(
    env.GEMINI_API_KEY,
    buildGenerationPrompt(complaint, safeCandidates, mType, !!cooperation?.enabled, preSummary || '', safeIssues),
    GENERATION_SCHEMA,
    0.3,
  );

  const selected = Array.isArray(generation?.selectedLawIds) ? generation.selectedLawIds : [];

  return json(
    {
      summary: generation?.summary || preSummary || '',
      draft: generation?.draft || '',
      selectedLawIds: selected,
      source: `gemini:${GEMINI_MODEL}`,
    },
    200,
    cors,
  );
}

// ─────────────────────────────────────────────
// Gemini #1 프롬프트 — 법령 제안
// ─────────────────────────────────────────────
function buildProposalPrompt(text, mType) {
  return `너는 대한민국 국민신문고 민원 전문가다. 아래 민원을 읽고 (1) 민원인의 질문을 분해하고 (2) 법제처 법령검색(aiSearch)용 검색어를 **여러 법적 관점에서** 만들어라.

[민원 원문]
${text}

[민원 유형]
${mType || 'normal'}

[너의 임무]
1. 민원의 핵심 요지 한 문장 (10~15자) — summary
   - 답변 3번 "귀하의 민원 내용은 '(요지)'에 관한 것으로 이해됩니다"에 삽입
   - 예: "학교급식 위생관리 개선 요청"

2. 민원인의 질문 개별 추출 (issues) — **매우 중요**
   - 민원 원문을 주의깊게 읽고 민원인이 실제로 묻고 있는 **질문·요구·궁금증을 모두** 뽑아낸다
   - 하나의 민원이 여러 질문을 포함할 수 있다 (명시적·묵시적 포함)
   - 각 항목은 "~여부", "~근거", "~절차", "~방법" 형태의 구체 질문으로
   - **민원인의 관점** 2가지를 꼭 고려하라:
     (a) 민원인이 행사하고 싶은 "권리" — 예: 열람권, 정정권, 신청권, 이의제기
     (b) 타인(운영자·기관)의 "행위·의무" — 예: 제공 제한, 처벌, 설치 의무
   - 민원이 두 관점을 동시에 건드리면 **둘 다 별개 issue로** 분리

   ❌ 나쁜 예 (한 덩어리로 뭉침):
   · 민원: "CCTV 영상 확인할 때 서약서 써야 하나? 제 영상 어떤 사람이 가져갔다는데 근거는?"
   · ["CCTV 영상 관련 문의"]  ← 너무 뭉침

   ✓ 좋은 예 (관점별 분리):
   · ["본인이 CCTV 영상 열람 시 보안서약서 작성 의무 여부",
      "제3자가 민원인의 영상을 가져간 행위의 법적 근거"]
   · → (a) 민원인의 열람권 관점 + (b) 운영자의 제공 제한 관점

   ✓ 다른 예 (교권침해):
   · ["교권 침해 발생 시 교원이 신청할 수 있는 보호 조치",
      "가해 학생에 대한 징계·제재 절차"]

3. 법제처 aiSearch 검색어 4~5개 (searchQueries) — **서로 다른 법적 관점에서**
   - 민원이 여러 법적 개념·쟁점을 건드린다면 **각각 별도 쿼리로** 만들어라
   - 민원인의 행위(신고·열람·신청 등)와 **민원인의 권리**를 모두 고려
   - 같은 주제의 표현 변형이 아니라 **다른 법적 측면**을 커버해야 함

   ❌ 나쁜 예 (같은 주제 반복):
   · 민원: "CCTV 보안서약서 작성 의무?"
   · ["CCTV 보안서약서 작성", "영상정보처리기기 서약", "CCTV 서약서"]
   · → 모두 "보안서약서" 관점만. 민원인의 "열람권" 관점 누락

   ✓ 좋은 예 (다각도):
   · 민원: "CCTV 보안서약서 작성 의무? 제 영상 제3자가 가져갔다는데 근거법이?"
   · ["CCTV 보안서약서 작성 의무", "개인정보 열람권", "정보주체 권리 열람", "영상정보처리기기 운영", "개인정보 제3자 제공"]
   · → 보안서약서(운영자 의무) + 열람권(민원인 권리) + 정보주체(정보보호) + 제공(제3자 이전) 등 다각도

   ✓ 좋은 예 (교권침해):
   · ["교권 침해 상담 신청", "교원 교육활동 보호", "학교교권보호위원회", "교원 지위 보호 조치"]

   ✓ 좋은 예 (체험학습 사고):
   · ["체험학습 안전사고 보상", "학교안전 공제급여 청구", "현장체험학습 안전", "학생 상해 치료비"]

   규칙:
   - 각 3~6단어, 자연어 짧은 구
   - 주제어는 학술적·행정적 용어로 (법제처 문서 투)
   - 법령명 대신 "개념/주제어" 사용 ("학교급식법" ❌ → "학교급식 위생" ✓)
   - 민원이 물어보는 **직접 주제** + 관련 **권리/절차/의무** 등 다각도 커버

3. 법령 근거가 필요한 사안인지 판단 (isLawRelated)
   - 단순 감사·칭찬·개인 감정 표현은 false → searchQueries는 빈 배열

[출력 형식]
반드시 아래 JSON으로만 응답:
{
  "isLawRelated": true,
  "summary": "CCTV 영상 열람 및 보안서약서 문의",
  "issues": [
    "본인이 CCTV 영상 열람 시 보안서약서 작성 의무 여부",
    "제3자가 민원인의 CCTV 영상을 가져간 행위의 법적 근거"
  ],
  "searchQueries": ["CCTV 보안서약서 작성", "개인정보 열람권", "정보주체 권리", "영상정보처리기기 운영", "개인정보 제3자 제공"]
}`;
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    isLawRelated: { type: 'boolean' },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
    searchQueries: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'issues', 'searchQueries'],
};

// ─────────────────────────────────────────────
// Gemini #2 프롬프트 — 답변 생성
// ─────────────────────────────────────────────
function buildGenerationPrompt(complaint, candidateLaws, mType, hasCooperation, preSummary, issues) {
  const lawsContext = candidateLaws.length
    ? candidateLaws
        .map((l, i) => {
          const arts = l.articles
            .map((a) => `  - 제${a.no}조 (${a.title}): ${a.content}`)
            .join('\n');
          return `[후보 ${i + 1}] ${l.name} (${l.kind}, ${l.ministry}) [ID:${l.lawId}]\n${arts}`;
        })
        .join('\n\n')
    : '(관련 법령 후보가 없습니다. 법령 인용 없이 일반적 행정 답변을 작성하세요.)';

  const mTypeHint =
    mType === 'transfer'
      ? '이첩 민원이므로 본문에는 해당 경로 안내가 자동 삽입됩니다.'
      : mType === 'avoid'
      ? '기피신청 민원이므로 본문에는 불수용 사유가 자동 삽입됩니다.'
      : mType === 'passive'
      ? '소극행정 신고 민원이므로 본문에는 감사부서 미처리 사유가 자동 삽입됩니다.'
      : '';

  const coopHint = hasCooperation
    ? '※ 이 민원은 협조민원입니다. 답변 본문에 협조기관(부서)의 답변을 반영할 수 있도록 구조를 유연하게 구성하되, 단순 나열이 아닌 종합정리 형태로 자연스럽게 서술하세요.'
    : '';

  const issuesBlock = (issues && issues.length > 0)
    ? `[민원인의 질문 목록 — 반드시 모두 답변]\n${issues.map((q, i) => `${i+1}. ${q}`).join('\n')}\n`
    : '';

  return `너는 서울특별시교육청 공무원이다. 아래 민원에 대한 답변을 작성하라. 민원인이 물어본 **모든 질문을 빠짐없이** 답하고, 후보 법령 중 **진짜 관련 있는 것**만 선별해서 근거로 인용하라.

[민원 원문]
${complaint}

${preSummary ? `[민원 요지]\n${preSummary}\n` : ''}
${issuesBlock}
[법령 후보 목록 — 법제처 aiSearch 검색 결과 (순서상 1위가 반드시 가장 관련 높은 것은 아님)]
${lawsContext}

[민원 유형]
${mType || 'normal'}
${mTypeHint}

${coopHint}

[답변 전 필수 분석]
1. 위 [민원인의 질문 목록]을 확인하고, **각 질문마다 답변해야 할 법령 조문**을 후보 목록에서 찾아라
2. **민원인의 관점 2가지를 꼭 고려**:
   (a) 민원인이 행사할 권리 — 열람권, 정정권, 이의신청, 처리정지 등
   (b) 기관·운영자의 의무 — 제공 제한, 처벌, 설치 의무, 절차 등
   질문이 권리 관련이면 "정보주체의 권리·열람" 관련 조문 반드시 찾기

[법령 선별 원칙]
1. 관련 있는 법령을 **최대 5개**까지 선별 (selectedLawIds에 법령ID 배열로 반환)
   - 질문이 여러 개면 질문별로 다른 법령이 필요할 수 있음
   - 질문 1개라도 여러 관점(권리·의무)이면 관련 법령 2~3개 필요
2. 선별한 법령 내에서 **관련 조문은 개수 제한 없이** 모두 인용
   - 1개 조문으로 충분하면 1개, 3개 필요하면 3개 모두 인용
3. 관련 법령이 전혀 없거나 모두 억지스러우면 **selectedLawIds=[] (빈 배열)**
4. 후보 목록에 없는 법령명·조문번호는 draft에 절대 언급 금지
5. 확신 없는 조문번호는 "「법령명」에 따라..." 식으로 번호 생략 허용

[draft 작성 규칙 — 검토 의견 본문]
1. 위 질문 목록의 **모든 질문을 커버**해야 한다
2. 반드시 "가. / 나. / 다." 구조화 (질문 개수에 맞게 항목 수 조정)
3. 각 항목은 3~5문장의 충분한 분량, 민원인 질문에 직접 답변
4. 법령 인용 시 「법령명」 제X조 형식
5. **selectedLawIds로 선별한 법령만** 인용
6. 제3자 개인정보·영업비밀 포함 금지
7. 구조 예시 (질문 2개 민원):
   가. [질문 1에 대한 답변 — 법령 근거 + 현황 + 결론]
   나. [질문 2에 대한 답변 — 법령 근거 + 현황 + 결론]
   다. [종합 안내 또는 추가 권리 정보]

[답변 말투 — 국민신문고 공식 답변 지침 ★★★ 절대 준수 ★★★]

[금지 패턴 — 절대 쓰지 마라]
각 항목(가/나/다)의 **첫 문장에 아래 패턴을 절대 쓰지 마라**:
  ❌ "~여부에 대해 문의하셨습니다"
  ❌ "~여부에 대해 답변드립니다"  ← 이것도 금지!
  ❌ "~에 대해 질문하셨습니다"
  ❌ "~에 대해 말씀하셨습니다"
  ❌ "~에 대해 안내드립니다" (서두로 쓰면 금지)
  ❌ "민원인께서 문의하신 ~에 대해"
  ❌ "~라고 말씀해 주셨습니다"

이유: 민원인의 질문을 답변이 매번 반복해서 읽는 건 비효율적이고 구식입니다.

[필수 패턴 — 첫 문장은 반드시 아래 중 하나로 시작]
  ✓ "「법령명」 제N조에 따라 ..." (법령 인용부터)
  ✓ "「법령명」 제N조는 ~을 규정하고 있습니다..."
  ✓ "현행 법령상 ~" (현행 규정 사실)
  ✓ "관련 법령을 확인한 결과 ~"
  ✓ "현재 우리 교육청은 ~을 운영하고 있습니다"
  ✓ "귀하의 경우 ~에 해당하므로..."
  ✓ "CCTV 영상정보는 ~에 해당합니다" (사실 명시)
  ✓ "본인 영상의 열람은 「개인정보 보호법」 제35조에 근거하여..."

[올바른 예시]
  민원: "CCTV 영상 열람 시 서약서 의무?"
  ❌ "가. CCTV 영상 열람 시 보안서약서 작성 의무 여부에 대해 답변드립니다. 「개인정보 보호법」 제35조에 따라..."
  ✓ "가. 「개인정보 보호법」 제35조에 따라 정보주체는 자신의 개인정보 열람을 요구할 수 있습니다. 본인 영상 열람 시 보안서약서 작성은 법령에 명시된 의무는 아니며, 개별 기관의 운영 방침에 따라 요구될 수 있음을 알려드립니다."

[공문서 마무리 표현 권장]
  · "~임을 알려드립니다"
  · "~에 해당함을 안내드립니다"
  · "~할 수 있음을 알려드립니다"
  · "~조치하겠습니다"
  · "양해하여 주시기 바랍니다"
  · "~하여 주시기 바랍니다"

[기타 금지]
  · "해당 부서로 문의", "홈페이지 참고", "이전 답변 참고" 등 떠넘기기·회피
  · "~같아요", "~인 듯합니다" 등 추측성
  · 구어체 ("~드릴게요", "~입니다요")

[민원인 권리 체크 — 반드시 확인]
- 민원이 "본인이 ~하려면" / "내가 받을 수 있나" / "제가 볼 수 있나" 형태이면
  → 후보에서 열람·정정·삭제·처리정지·이의제기 등 **권리 조문** 찾기
- 개인정보 관련 민원이면 「개인정보 보호법」 제4조(정보주체 권리), 제35~38조(열람·정정·처리정지·권리행사) 확인
- 교원·학생 관련 민원이면 관련 보호법의 권리 조문 확인

반드시 아래 JSON 형식으로만 응답:
{
  "summary": "민원 요지 (따옴표 없이)",
  "draft": "가. ...\\n\\n나. ...\\n\\n다. ...",
  "selectedLawIds": ["000889"]
}`;
}

const GENERATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    draft: { type: 'string' },
    selectedLawIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'draft'],
};

// ─────────────────────────────────────────────
// /api/evaluate-edit — 본문 편집 재채점
// ─────────────────────────────────────────────
async function handleEvaluateEdit(body, env, cors) {
  const { bodyText, originalComplaint, mType } = body;
  if (!bodyText || typeof bodyText !== 'string') {
    return json({ error: '본문이 필요합니다' }, 400, cors);
  }

  // 정규식 사전 필터 — 명백한 패턴 감지
  const preSignals = {
    passBuck: AI_DEDUCTIONS.passBuck.preFilter?.test(bodyText) || false,
    refOnly: AI_DEDUCTIONS.refOnly.preFilter?.test(bodyText) || false,
  };

  // Gemini 판정
  const prompt = buildEvaluatePrompt(bodyText, originalComplaint || '', mType || 'normal', preSignals);

  const result = await callGemini(env.GEMINI_API_KEY, prompt, EVALUATE_SCHEMA, 0.0);

  // 점수 계산
  let sincerity = SINCERITY_BASE;
  const triggered = {};
  for (const key of ['privacy', 'jurisdiction', 'passBuck', 'refOnly']) {
    const r = result?.[key];
    if (r && r.triggered === true) {
      sincerity += AI_DEDUCTIONS[key].penalty;
      triggered[key] = r;
    } else {
      triggered[key] = { triggered: false };
    }
  }
  sincerity = Math.max(0, sincerity);

  return json(
    {
      sincerity: { pts: sincerity, max: SINCERITY_BASE },
      privacy: triggered.privacy,
      jurisdiction: triggered.jurisdiction,
      passBuck: triggered.passBuck,
      refOnly: triggered.refOnly,
    },
    200,
    cors,
  );
}

function buildEvaluatePrompt(bodyText, complaint, mType, preSignals) {
  return `너는 국민신문고 민원답변 충실도 평가관이다. 아래 답변 본문을 4개 항목으로 판정하라.

[민원 원문]
${complaint.slice(0, 800)}

[답변 본문 — 평가 대상]
${bodyText.slice(0, 2000)}

[민원 유형]
${mType}

[평가 항목 — 각각 triggered: true/false로 판정]

① privacy (-20): 답변에 필요하지 않은 제3자의 개인정보(이름·주민번호·전화·주소), 영업상 비밀 등이 포함되었는가?
   ※ 담당자 정보(부서/성명/전화) 안내는 해당 없음
   ※ 민원인 본인의 정보는 해당 없음

② jurisdiction (-10): "우리 소관이 아니다"라고 안내하는 경우, 그 이유/소관기관/처리방법 중 하나라도 누락되었는가?
   ※ 소관 민원이면 triggered=false (해당 없음)

③ passBuck (-10): 답변기관의 다른 부서나 기관으로 민원처리를 미루거나 떠넘기는 표현이 있는가?
   예: "자세한 사항은 해당 부서로 문의", "직접 OO과로 연락"
   ※ 종결부 "담당자 OOO 주무관(☏...)" 연락처 안내는 해당 없음

④ refOnly (-10): 요구를 수용하지 않으면서 "이전 답변 참고", "홈페이지 확인", "전화 문의" 등 회피성 안내를 했는가?

[정규식 사전 신호]
passBuck 패턴 의심: ${preSignals.passBuck ? '있음' : '없음'}
refOnly 패턴 의심: ${preSignals.refOnly ? '있음' : '없음'}
(위 신호는 참고용이며 최종 판정은 맥락으로 판단하라)

[출력 형식]
반드시 아래 JSON으로만 응답하라. 각 항목마다 triggered(bool) + evidence(원문 인용 또는 null).

{
  "privacy": { "triggered": false, "evidence": null },
  "jurisdiction": { "triggered": false, "evidence": null },
  "passBuck": { "triggered": false, "evidence": null },
  "refOnly": { "triggered": false, "evidence": null }
}`;
}

const EVALUATE_SCHEMA = {
  type: 'object',
  properties: {
    privacy: {
      type: 'object',
      properties: {
        triggered: { type: 'boolean' },
        evidence: { type: 'string', nullable: true },
      },
    },
    jurisdiction: {
      type: 'object',
      properties: {
        triggered: { type: 'boolean' },
        evidence: { type: 'string', nullable: true },
      },
    },
    passBuck: {
      type: 'object',
      properties: {
        triggered: { type: 'boolean' },
        evidence: { type: 'string', nullable: true },
      },
    },
    refOnly: {
      type: 'object',
      properties: {
        triggered: { type: 'boolean' },
        evidence: { type: 'string', nullable: true },
      },
    },
  },
};

// ─────────────────────────────────────────────
// /api/laws — 탭 3 단독 법령 검색 (Gemini 0회)
// ─────────────────────────────────────────────
async function handleLawsSearch(query, cors) {
  if (!query.trim()) return json({ items: [] }, 200, cors);
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  const result = await fetchAiSearch(query.trim(), cache);
  const items = Array.isArray(result.법령조문) ? result.법령조문 : [result.법령조문].filter(Boolean);

  const mapped = items.slice(0, 15).map((it) => ({
    lawId: it.법령ID,
    mst: it.법령일련번호,
    name: it.법령명,
    articleNo: String(it.조문번호 || '').replace(/^0+/, '') || '',
    articleTitle: it.조문제목 || '',
    content: it.조문내용 || '',
    kind: it.법령종류명 || '',
    ministry: it.소관부처명 || '',
    effectiveDate: formatYmd(it.시행일자),
    link: it.법령일련번호 ? `https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=${it.법령일련번호}` : '',
  }));

  return json({ items: mapped, query }, 200, cors);
}
