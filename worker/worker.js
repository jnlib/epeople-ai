export default {
  async fetch(request, env) {
    // CORS headers
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
        const { text, dept, mode } = await request.json();
        if (!text) {
          return json({ error: '원문이 없습니다.' }, 400, corsHeaders);
        }

        // 1) Workers AI: 요약 + 초안 생성
        const aiResult = await generateDraft(env.AI, text, dept);

        // 2) Workers AI: 법령 키워드 추출 → 법제처 API 검증
        const laws = await findRelatedLaws(env.AI, text);

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
async function generateDraft(ai, text, dept) {
  const prompt = `당신은 대한민국 서울시교육청 민원 답변 전문가입니다.
아래 민원 원문을 분석하여 JSON으로 답변하세요.

민원 원문:
"""
${text.slice(0, 3000)}
"""

다음 JSON 형식으로만 답변하세요 (다른 텍스트 없이):
{
  "summary": "민원 핵심 요지를 1~2문장으로 요약",
  "draft": "가. 첫째 답변 내용\\n나. 둘째 답변 내용\\n다. 셋째 답변 내용"
}

주의:
- summary는 30자 이내로 간결하게
- draft는 가.나.다. 형식으로 구체적이고 성실하게 작성
- 실제 법령명을 언급할 때는 정확한 법령명만 사용
- 추측성 답변은 하지 마세요`;

  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.3,
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

// ─── Workers AI: 법령 키워드 추출 → 법제처 API 검증 ───
async function findRelatedLaws(ai, text) {
  // Step 1: AI에게 법령 검색 키워드 추출 요청
  const kwPrompt = `아래 민원 내용과 관련된 대한민국 법령을 찾기 위한 검색 키워드를 추출하세요.

민원 내용:
"""
${text.slice(0, 2000)}
"""

규칙:
- 법령명으로 검색할 키워드 3~5개를 추출
- 예: "학교급식", "식품위생", "교육공무원" 등
- JSON 배열로만 답변: ["키워드1", "키워드2", "키워드3"]
- 다른 텍스트 없이 JSON 배열만 출력`;

  let keywords = [];
  try {
    const kwRes = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: kwPrompt }],
      max_tokens: 256,
      temperature: 0.2,
    });
    const raw = kwRes.response || '';
    const arrMatch = raw.match(/\[[\s\S]*?\]/);
    if (arrMatch) {
      keywords = JSON.parse(arrMatch[0]).filter(k => typeof k === 'string').slice(0, 5);
    }
  } catch {}

  if (keywords.length === 0) return [];

  // Step 2: 키워드별 법제처 API 호출
  const LAW_OC = 'hdh1231';
  const seen = new Set();
  const laws = [];

  const fetches = keywords.map(async (kw) => {
    try {
      const apiUrl = `https://www.law.go.kr/DRF/lawSearch.do?OC=${LAW_OC}&target=law&type=JSON&query=${encodeURIComponent(kw)}&display=3`;
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();

      // 법제처 응답 구조: { LawSearch: { law: [...] } } 또는 배열
      let items = [];
      if (data?.LawSearch?.law) {
        items = Array.isArray(data.LawSearch.law) ? data.LawSearch.law : [data.LawSearch.law];
      }

      for (const item of items) {
        const name = item['법령명한글'] || item['법령명'] || '';
        if (!name || seen.has(name)) continue;
        seen.add(name);
        laws.push({
          name,
          url: `https://www.law.go.kr/법령/${encodeURIComponent(name)}`,
        });
      }
    } catch {}
  });

  await Promise.all(fetches);
  return laws.slice(0, 8);
}
