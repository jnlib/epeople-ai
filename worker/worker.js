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

        const result = await generateDraft(env.AI, text);

        return json({
          summary: result.summary,
          draft: result.draft,
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

// draft가 객체면 문자열로 변환
function ensureString(val) {
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    // {가: "내용", 나: "내용"} 형태 처리
    return Object.entries(val).map(([k, v]) => `${k}. ${v}`).join('\n');
  }
  return String(val);
}

async function generateDraft(ai, text) {
  const prompt = `너는 대한민국 서울특별시교육청 민원 답변을 작성하는 공무원이다.
아래 민원 원문을 정확히 읽고, 반드시 원문 내용에 기반하여 답변하라.

[민원 원문]
${text.slice(0, 3000)}

[지시사항]
아래 JSON 형식으로만 응답하라. JSON 외 텍스트는 절대 출력하지 마라.

{"summary":"민원 핵심을 15자 이내로 요약","draft":"가. 첫째 답변 내용. 구체적으로 2~3문장 작성.\\n나. 둘째 답변 내용. 구체적으로 2~3문장 작성.\\n다. 셋째 답변 내용. 구체적으로 2~3문장 작성."}

[필수 규칙]
- summary: 반드시 원문의 핵심 주제만 담아라.
- draft: 반드시 하나의 문자열로, "가. ... \\n나. ... \\n다. ..." 형식으로 작성하라.
- draft를 절대 객체나 배열로 만들지 마라. 반드시 문자열이어야 한다.
- 확실하지 않은 법령명이나 조문번호는 쓰지 마라.
- 원문에 없는 내용을 지어내지 마라.`;

  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: '너는 JSON만 출력하는 민원 답변 생성기다. summary와 draft 모두 문자열(string)로만 출력하라. 객체나 배열 금지.' },
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
        summary: ensureString(parsed.summary),
        draft: ensureString(parsed.draft),
      };
    }
  } catch {}

  return { summary: '', draft: '' };
}
