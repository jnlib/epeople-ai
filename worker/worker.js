export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/generate' && request.method === 'POST') {
      try {
        const { text } = await request.json();
        if (!text) {
          return json({ error: '원문이 없습니다.' }, 400, corsHeaders);
        }

        // AI 분석 + 법령 검색을 병렬로 실행
        const [aiResult, laws] = await Promise.all([
          generateDraft(env.AI, text),
          findRelatedLaws(env.AI, text),
        ]);

        return json({
          summary: aiResult.summary,
          draft: aiResult.draft,
          laws,
        }, 200, corsHeaders);
      } catch (e) {
        return json({ error: e.message || '서버 오류' }, 500, corsHeaders);
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ─── Workers AI: 민원 요약 + 답변 초안 ───
async function generateDraft(ai, text) {
  const prompt = `너는 대한민국 서울특별시교육청 민원 답변을 작성하는 공무원이다.
아래 민원 원문을 정확히 읽고, 반드시 원문 내용에 기반하여 답변하라.

[민원 원문]
${text.slice(0, 3000)}

[지시사항]
아래 JSON 형식으로만 응답하라. JSON 외 텍스트는 절대 출력하지 마라.
{
  "summary": "민원 핵심 내용을 15자 이내로 요약 (예: 학교급식 위생점검 요청)",
  "draft": "가. 첫째 답변\\n나. 둘째 답변\\n다. 셋째 답변"
}

[필수 규칙]
- summary는 반드시 원문의 핵심 주제를 담아라. 원문과 무관한 내용 금지.
- draft의 각 항목은 구체적으로 2~3문장씩 작성하라.
- 확실하지 않은 법령명이나 조문번호는 쓰지 마라.
- 원문에 없는 내용을 지어내지 마라.`;

  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: '너는 JSON만 출력하는 민원 답변 생성기다. JSON 외 어떤 텍스트도 출력하지 마라.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 1024,
    temperature: 0.2,
  });

  try {
    const raw = response.response || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || '',
        draft: parsed.draft || '',
      };
    }
  } catch {}

  return { summary: '', draft: '' };
}

// ─── 법령 키워드 추출 + 법제처 API 검증 ───
async function findRelatedLaws(ai, text) {
  // Step 1: AI에게 법령 키워드 추출
  const kwPrompt = `아래 민원에서 관련 법령을 찾기 위한 검색 키워드를 추출하라.

[민원]
${text.slice(0, 2000)}

[규칙]
- 이 민원과 관련된 대한민국 법률/시행령 이름의 핵심 단어를 3~5개 추출
- 반드시 JSON 배열로만 응답: ["키워드1","키워드2","키워드3"]
- 예시: 급식 관련이면 ["학교급식","식품위생","교육시설"]
- 예시: 교원 관련이면 ["교육공무원","교원지위","초중등교육"]
- JSON 배열 외 다른 텍스트 절대 출력 금지`;

  let keywords = [];
  try {
    const kwRes = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'JSON 배열만 출력하라. 다른 텍스트 금지.' },
        { role: 'user', content: kwPrompt },
      ],
      max_tokens: 128,
      temperature: 0.1,
    });
    const raw = kwRes.response || '';
    const arrMatch = raw.match(/\[[\s\S]*?\]/);
    if (arrMatch) {
      keywords = JSON.parse(arrMatch[0])
        .filter(k => typeof k === 'string' && k.length >= 2)
        .slice(0, 5);
    }
  } catch {}

  // 키워드 추출 실패 시: 원문에서 직접 핵심 명사 추출 (폴백)
  if (keywords.length === 0) {
    const fallback = text.match(/[가-힣]{2,6}(법|령|규칙|조례)/g);
    if (fallback) keywords = [...new Set(fallback)].slice(0, 3);
  }
  if (keywords.length === 0) return [];

  // Step 2: 키워드별 법제처 API 병렬 호출
  const LAW_OC = 'hdh1231';
  const seen = new Set();
  const laws = [];

  await Promise.all(keywords.map(async (kw) => {
    try {
      const apiUrl = `https://www.law.go.kr/DRF/lawSearch.do?OC=${LAW_OC}&target=law&type=JSON&query=${encodeURIComponent(kw)}&display=3`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;

      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      // 법제처 JSON 응답 파싱 — 구조가 다양할 수 있음
      let items = [];
      if (data?.LawSearch?.law) {
        items = Array.isArray(data.LawSearch.law) ? data.LawSearch.law : [data.LawSearch.law];
      } else if (data?.law) {
        items = Array.isArray(data.law) ? data.law : [data.law];
      }

      for (const item of items) {
        const name = item['법령명한글'] || item['법령명'] || item.lawNameKorean || '';
        if (!name || seen.has(name)) continue;
        seen.add(name);
        laws.push({
          name,
          url: `https://www.law.go.kr/법령/${encodeURIComponent(name)}`,
        });
      }
    } catch {}
  }));

  return laws.slice(0, 8);
}
