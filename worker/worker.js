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

function ensureString(val) {
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    return Object.entries(val).map(([k, v]) => `${k}. ${v}`).join('\n');
  }
  return String(val);
}

async function generateDraft(ai, text) {
  const systemPrompt = `너는 대한민국 서울특별시교육청 소속 공무원이다.
국민신문고 민원에 대한 "검토 의견"을 작성하는 것이 임무다.
반드시 JSON만 출력하라. JSON 외 어떤 텍스트도 출력 금지.`;

  const userPrompt = `아래 국민신문고 민원 원문을 읽고 답변을 작성하라.

[민원 원문]
${text.slice(0, 3000)}

[출력 형식 - 반드시 이 JSON만 출력]
{"summary":"민원 핵심을 15자 이내로 요약","draft":"가. ...\\n나. ...\\n다. ..."}

[summary 규칙]
- 민원인이 무엇을 요청/문의했는지를 15자 이내로 적어라
- 예: "학교급식 위생점검 요청", "전입학 절차 문의", "교원 복무 관련 건의"

[draft 규칙 - 매우 중요]
draft는 국민신문고 답변의 "4. 검토 의견" 부분이다.
민원인의 요청에 대한 실질적인 답변을 가.나.다. 형식으로 작성하라.

작성 방법:
- 가. 민원인의 요청/문의 사항에 대한 현황 설명 또는 조치 결과를 구체적으로 기술
- 나. 관련 제도, 절차, 근거를 설명 (법령명은 확실한 것만)
- 다. 향후 계획, 추가 안내사항, 또는 양해 요청

작성 예시 (급식 위생 민원인 경우):
"가. 귀하께서 지적하신 급식실 위생 관련 사항에 대하여 확인한 결과, 해당 학교 조리실 환기시설은 2023년 설치 이후 정기점검을 실시하고 있으며, 식자재 보관 온도는 관련 기준에 따라 관리되고 있음을 알려드립니다.\\n나. 학교급식의 위생관리는 관련 법령에 따라 교육청 및 학교에서 연 2회 이상 정기 위생점검을 실시하고 있으며, 점검 결과에 따라 시정조치를 이행하고 있습니다.\\n다. 다만, 귀하의 소중한 의견을 반영하여 해당 학교에 대한 특별 위생점검을 실시하고, 미비한 사항이 있을 경우 즉시 개선하도록 조치하겠습니다."

절대 하지 말 것:
- 민원 내용을 그대로 반복하거나 요약만 하지 마라
- "문의하세요", "확인하세요" 같은 떠넘기기 답변 금지
- 확실하지 않은 법령 조문번호 금지
- draft를 객체나 배열로 만들지 마라. 반드시 하나의 문자열이어야 한다`;

  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1500,
    temperature: 0.3,
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
