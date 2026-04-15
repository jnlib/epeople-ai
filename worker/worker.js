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
  const queries = Array.isArray(proposal?.searchQueries)
    ? proposal.searchQueries.filter((q) => typeof q === 'string' && q.trim().length > 0)
    : [];
  if (preSummary && !queries.includes(preSummary)) queries.push(preSummary);
  const isLawRelated = proposal?.isLawRelated !== false;

  return json(
    {
      summary: preSummary,
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
  const { text, mType, cooperation, candidateLaws, preSummary } = body;
  if (!text || typeof text !== 'string') {
    return json({ error: '민원 원문이 필요합니다' }, 400, cors);
  }
  const complaint = text.slice(0, 3000);
  const safeCandidates = Array.isArray(candidateLaws) ? candidateLaws.slice(0, 8) : [];

  const generation = await callGemini(
    env.GEMINI_API_KEY,
    buildGenerationPrompt(complaint, safeCandidates, mType, !!cooperation?.enabled, preSummary || ''),
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
  return `너는 대한민국 국민신문고 민원 전문가다. 아래 민원을 읽고 법제처 법령검색에 쓸 최적의 자연어 검색어를 여러 개 만들어라.

[민원 원문]
${text}

[민원 유형]
${mType || 'normal'}

[너의 임무]
1. 민원의 핵심 요지 한 문장 (10~15자) — summary
   - 답변 3번 "귀하의 민원 내용은 '(요지)'에 관한 것으로 이해됩니다"에 삽입
   - 예: "학교급식 위생관리 개선 요청"

2. 법제처 '지능형 검색(aiSearch)' 전용 검색어를 **서로 다른 관점에서 3개** 생성 (searchQueries)
   - 각 3~6단어, 자연어 짧은 구
   - 1번 쿼리가 0건 반환해도 다른 쿼리로 재시도할 수 있도록 **의미는 같되 표현 다변화**
   - 첫 번째는 가장 구체적, 마지막은 가장 일반적 주제어
   - 좋은 예 (교권침해 민원):
     · ["교권 침해 상담 신청", "교원 교육활동 보호", "교원 지위 보호"]
   - 좋은 예 (학교급식 위생):
     · ["학교급식 위생 안전관리", "급식 위생 점검", "학교급식 운영"]
   - 좋은 예 (체험학습 사고):
     · ["체험학습 안전사고 보상", "학교 안전사고 공제", "학교안전 공제급여"]
   - 나쁜 예: ["민원", "학교"] (너무 일반적), ["학교급식법"] (법령명 대신 주제어 사용)
   - 주제어는 학술적·행정적 용어로 (법제처 문서 투 의식)

3. 법령 근거가 필요한 사안인지 판단 (isLawRelated)
   - 단순 감사·칭찬·개인 감정 표현은 false → searchQueries는 빈 배열

[출력 형식]
반드시 아래 JSON으로만 응답:
{
  "isLawRelated": true,
  "summary": "학교급식 위생관리 개선 요청",
  "searchQueries": ["학교급식 위생 안전관리", "급식 위생 점검", "학교급식 운영"]
}`;
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    isLawRelated: { type: 'boolean' },
    summary: { type: 'string' },
    searchQueries: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'searchQueries'],
};

// ─────────────────────────────────────────────
// Gemini #2 프롬프트 — 답변 생성
// ─────────────────────────────────────────────
function buildGenerationPrompt(complaint, candidateLaws, mType, hasCooperation, preSummary) {
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

  return `너는 서울특별시교육청 공무원이다. 아래 민원에 대한 답변을 작성하되, 아래 후보 법령 중 **진짜 관련 있는 것만 직접 선별**해서 그 법령만 근거로 인용하라.

[민원 원문]
${complaint}

${preSummary ? `[이미 추출된 민원 요지]\n${preSummary}\n` : ''}

[법령 후보 목록 — 법제처 aiSearch 검색 결과 (순서상 1위가 반드시 가장 관련 높은 것은 아님)]
${lawsContext}

[민원 유형]
${mType || 'normal'}
${mTypeHint}

${coopHint}

[너의 임무]
1. 후보 법령 중 **이 민원에 진짜 관련 있는 것만 1~3개 선별** (selectedLawIds에 법령ID 배열로 반환)
   - 법제처 검색 1위가 엉뚱하면 2위/3위를 골라라
   - "조금 관련있어 보이는" 수준은 제외 (직접 관련만)
   - 관련 법령이 전혀 없거나 모두 억지스러우면 **selectedLawIds=[] (빈 배열)**
   - 억지 인용보다 법령 없는 일반 행정 답변이 낫다
2. 선별한 법령만 근거로 본문 draft 작성
   - **후보 목록에 없는 법령명·조문번호는 절대 draft에 언급 금지**
   - 확신 없는 조문번호는 "「법령명」에 따라..." 식으로 번호 생략 허용

[summary 작성 규칙]
- 10~15자 한 문장 요약 (따옴표 사용 금지)
- 예: "학교급식 위생관리 개선 요청"
- 이미 추출된 민원 요지가 있으면 그대로 사용

[draft 작성 규칙 — 검토 의견 본문]
1. 반드시 "가. / 나. / 다." 구조화 (최소 2항목, 권장 3항목)
2. 각 항목은 3~5문장의 충분한 분량
3. 법령 인용 시 「법령명」 제X조 형식으로 정확히 인용
4. **selectedLawIds로 선별한 법령만** 인용. 나머지 후보 인용 금지. 목록 외 법령/조문 지어내기 절대 금지
5. 공문서 어투 ("~을 알려드립니다", "~조치하겠습니다")
6. 금지 표현: "해당 부서로 문의", "홈페이지 참고", "이전 답변 참고" 등 떠넘기기·회피 표현
7. 제3자 개인정보·영업비밀 포함 금지
8. 구조 예시:
   가. [현황 파악/확인 결과]
   나. [관련 제도·법령 설명 — 선별 법령만 인용]
   다. [향후 조치 계획·양해 요청]

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
