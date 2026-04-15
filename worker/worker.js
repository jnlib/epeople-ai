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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const LAW_OC = 'hdh1231';
const LAW_BASE = 'https://www.law.go.kr/DRF';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/health') {
        return json({
          status: 'ok',
          service: 'epeople-ai-v2',
          version: RUBRIC_VERSION,
          geminiKey: !!env.GEMINI_API_KEY,
        });
      }

      if (path === '/api/generate' && request.method === 'POST') {
        const body = await request.json();
        return await handleGenerate(body, env);
      }

      if (path === '/api/evaluate-edit' && request.method === 'POST') {
        const body = await request.json();
        return await handleEvaluateEdit(body, env);
      }

      if (path === '/api/laws' && request.method === 'GET') {
        const query = url.searchParams.get('query') || '';
        return await handleLawsSearch(query);
      }

      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || 'Server error', stack: e.stack?.slice(0, 400) }, 500);
    }
  },
};

// ─────────────────────────────────────────────
// 공통: JSON 응답
// ─────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
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

// 법제처 fetch with retry — Cloudflare → law.go.kr 간 525/타임아웃 대응
async function lawFetchWithRetry(url, timeoutMs = 25000, maxRetries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EpeopleBot/1.0)' },
        signal: AbortSignal.timeout(timeoutMs),
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      const text = await res.text();
      // 525/프레임/HTML 페이지 감지
      if (
        text.includes('error code: 525') ||
        text.includes('<!DOCTYPE') ||
        text.includes('error500') ||
        text.includes('미신청')
      ) {
        lastErr = new Error('법제처 응답 오류: ' + text.slice(0, 100));
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        return null;
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
    }
  }
  console.log('lawFetch 최종 실패:', lastErr?.message);
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
  const text = await lawFetchWithRetry(`${LAW_BASE}/lawService.do?${qs}`, 28000);
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
// 법령명 검증: eflaw 1차 → aiSearch 폴백
// ─────────────────────────────────────────────
async function verifyLawName(name, cache) {
  // 1차: eflaw search=1
  const r1 = await fetchEflawByName(name, cache);
  if (parseInt(r1.totalCnt || '0', 10) > 0) {
    const laws = Array.isArray(r1.law) ? r1.law : [r1.law];
    return laws.map((l) => ({
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

  // 2차 폴백: aiSearch (약칭 지원)
  const r2 = await fetchAiSearch(name, cache);
  const items = Array.isArray(r2.법령조문) ? r2.법령조문 : [r2.법령조문].filter(Boolean);
  if (items.length === 0) return [];

  // 같은 법령ID 하나만 (첫 결과 기준)
  const seen = new Set();
  const result = [];
  for (const it of items) {
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
    if (result.length >= 2) break; // 폴백은 최대 2개
  }
  return result;
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
async function handleGenerate(body, env) {
  const { text, mType, cooperation } = body;
  if (!text || typeof text !== 'string') {
    return json({ error: '민원 원문이 필요합니다' }, 400);
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const complaint = text.slice(0, 3000);

  // ═════ Gemini #1: 법령 제안 ═════
  const proposal = await callGemini(
    env.GEMINI_API_KEY,
    buildProposalPrompt(complaint, mType),
    PROPOSAL_SCHEMA,
    0.2,
  );

  const proposedLaws = Array.isArray(proposal?.proposedLaws) ? proposal.proposedLaws : [];
  const isLawRelated = proposal?.isLawRelated !== false;

  // ═════ 법령 검증 + 본문 조회 ═════
  let verifiedLaws = [];
  let unverifiedLaws = [];

  if (isLawRelated && proposedLaws.length > 0) {
    const verifications = await Promise.all(
      proposedLaws.slice(0, 5).map(async (p) => {
        try {
          const matches = await verifyLawName(p.name, cache);
          if (matches.length === 0) return { fail: true, name: p.name };
          // 첫 매칭 (본법) 하나만 깊이 조회
          const primary = matches[0];
          const detail = await fetchLawBody(primary.lawId, cache);
          if (!detail) return { fail: true, name: p.name };
          // topics 힌트로 조문 필터링
          const topicArts = filterArticlesByTopics(detail.articles, p.topics || []);
          return {
            fail: false,
            data: { ...detail, mst: detail.mst || primary.mst, articles: topicArts },
          };
        } catch (e) {
          return { fail: true, name: p.name, error: e.message };
        }
      }),
    );
    verifiedLaws = verifications.filter((v) => !v.fail).map((v) => v.data);
    unverifiedLaws = verifications.filter((v) => v.fail).map((v) => v.name);
  }

  // ═════ Gemini #2: 답변 생성 ═════
  const generation = await callGemini(
    env.GEMINI_API_KEY,
    buildGenerationPrompt(complaint, verifiedLaws, mType, !!cooperation?.enabled),
    GENERATION_SCHEMA,
    0.3,
  );

  // ═════ 응답 조립 ═════
  const lawsForUi = verifiedLaws.map((l) => {
    const mainArticle = l.articles?.[0];
    return {
      lawId: l.lawId,
      mst: l.mst,
      name: l.name,
      shortName: l.shortName,
      kind: l.kind,
      ministry: l.ministry,
      effectiveDate: l.effectiveDate,
      articleNo: mainArticle?.no || '',
      articleTitle: mainArticle?.title || '',
      content: mainArticle?.content || '',
      allArticles: l.articles,
      link: l.mst ? `https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=${l.mst}` : '',
    };
  });

  return json({
    summary: generation?.summary || '',
    draft: generation?.draft || '',
    laws: lawsForUi,
    unverifiedLaws,
    isLawRelated,
    mainIntent: proposal?.mainIntent || '',
    source: `gemini:${GEMINI_MODEL}`,
  });
}

// ─────────────────────────────────────────────
// Gemini #1 프롬프트 — 법령 제안
// ─────────────────────────────────────────────
function buildProposalPrompt(text, mType) {
  return `너는 대한민국 행정 법률 전문가다. 아래 국민신문고 민원을 읽고 관련 법령을 제안하라.

[민원 원문]
${text}

[민원 유형]
${mType || 'normal'}

[너의 임무]
1. 이 민원이 법령 근거가 필요한 행정 사안인지 판단 (isLawRelated)
2. 관련될 수 있는 대한민국 현행 법령의 '정식 명칭' 1~5개 제안
3. 각 법령에서 주로 참고할 주제(topics) 2~4개 함께 제안

[엄격 규칙]
- 법령 '정식 명칭'만 사용하라. 약칭 금지.
  예: ❌ "교원지위법"  ✅ "교원의 지위 향상 및 교육활동 보호를 위한 특별법"
  예: ❌ "학교안전법"  ✅ "학교안전사고 예방 및 보상에 관한 법률"
- 불확실한 법령은 절대 제안하지 마라. 존재 여부 불확실하면 생략.
- 민원이 단순 감사·칭찬·개인적 의견 등 법령 무관이면 isLawRelated=false로 하고 proposedLaws는 빈 배열.
- topics는 해당 법령에서 민원과 관련될 조문 주제 키워드 (조문 제목에 나올 만한 단어)
  예: "학교급식법" → topics: ["위생", "안전관리", "운영"]

반드시 아래 JSON 형식으로만 응답하라:
{
  "isLawRelated": true,
  "mainIntent": "민원의 핵심 의도 한 문장",
  "proposedLaws": [
    {"name": "학교급식법", "topics": ["위생", "안전관리"]},
    {"name": "학교보건법", "topics": ["환경위생", "식품위생"]}
  ]
}`;
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    isLawRelated: { type: 'boolean' },
    mainIntent: { type: 'string' },
    proposedLaws: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          topics: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
    },
  },
  required: ['isLawRelated', 'proposedLaws'],
};

// ─────────────────────────────────────────────
// Gemini #2 프롬프트 — 답변 생성
// ─────────────────────────────────────────────
function buildGenerationPrompt(complaint, verifiedLaws, mType, hasCooperation) {
  const lawsContext = verifiedLaws.length
    ? verifiedLaws
        .map((l, i) => {
          const arts = l.articles
            .map((a) => `  - 제${a.no}조 (${a.title}): ${a.content}`)
            .join('\n');
          return `[법령 ${i + 1}] ${l.name} (${l.kind}, ${l.ministry}) [ID:${l.lawId}]\n${arts}`;
        })
        .join('\n\n')
    : '(관련 법령을 찾지 못했습니다. 법령 인용 없이 일반적 행정 답변을 작성하세요.)';

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

  return `너는 서울특별시교육청 공무원이다. 아래 민원에 대한 공식 답변의 "민원 요지"와 "검토 의견 본문"을 작성하라.

[민원 원문]
${complaint}

[참고 법령 — 반드시 이 범위 내에서만 인용]
${lawsContext}

[민원 유형]
${mType || 'normal'}
${mTypeHint}

${coopHint}

[summary 작성 규칙 — 민원 요지]
- 민원인이 무엇을 요청/건의/문의했는지를 한 문장(15자 이내)으로 요약
- 예: "학교급식 위생관리 개선 요청", "교원 복무 관련 건의"
- 큰따옴표나 따옴표 사용 금지 (UI에서 자동 래핑됨)

[draft 작성 규칙 — 검토 의견 본문]
1. 반드시 "가. / 나. / 다." 구조화 (최소 2항목, 권장 3항목)
2. 각 항목은 3~5문장의 충분한 분량으로 작성
3. 법령 인용 시 「법령명」 제X조 형식으로 정확히 인용
4. 위 참고 법령 목록에 없는 법령/조문번호는 절대 지어내지 마라 (감점 사유)
5. 공문서 어투 ("~을 알려드립니다", "~하고 있습니다", "~조치하겠습니다")
6. 정중한 표현, 민원인 입장 존중
7. 금지 표현:
   - "해당 부서로 문의" 같은 떠넘기기 금지
   - "홈페이지 참고" 같은 회피성 안내 금지
   - 제3자 개인정보·영업비밀 포함 금지
   - 단순 이전 답변 참고 안내 금지
8. 구조 예시:
   가. [현황 파악/확인 결과 — 구체적 사실]
   나. [관련 제도·법령 설명 — 참고 법령 중에서만 인용]
   다. [향후 조치 계획·양해 요청]

반드시 아래 JSON 형식으로만 응답하라:
{
  "summary": "민원 요지 (15자 이내, 따옴표 없이)",
  "draft": "가. ...\\n\\n나. ...\\n\\n다. ...",
  "citedLawIds": ["000889", "000890"]
}`;
}

const GENERATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    draft: { type: 'string' },
    citedLawIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'draft'],
};

// ─────────────────────────────────────────────
// /api/evaluate-edit — 본문 편집 재채점
// ─────────────────────────────────────────────
async function handleEvaluateEdit(body, env) {
  const { bodyText, originalComplaint, mType } = body;
  if (!bodyText || typeof bodyText !== 'string') {
    return json({ error: '본문이 필요합니다' }, 400);
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

  return json({
    sincerity: { pts: sincerity, max: SINCERITY_BASE },
    privacy: triggered.privacy,
    jurisdiction: triggered.jurisdiction,
    passBuck: triggered.passBuck,
    refOnly: triggered.refOnly,
  });
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
async function handleLawsSearch(query) {
  if (!query.trim()) return json({ items: [] });
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

  return json({ items: mapped, query });
}
