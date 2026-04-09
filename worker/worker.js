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

        const result = await generateDraft(env.GEMINI_API_KEY, text);

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

async function generateDraft(apiKey, text) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  }

  const prompt = `너는 대한민국 서울특별시교육청 소속 공무원이다.
국민신문고에 접수된 아래 민원에 대한 공식 답변을 작성하라.

[민원 원문]
${text.slice(0, 5000)}

[너의 임무]
국민신문고 답변 서식의 "3. 민원 요지"와 "4. 검토 의견" 부분을 작성한다.

[출력 형식]
반드시 아래 JSON 형식으로만 답변하라. 다른 텍스트나 마크다운 코드 블록(\`\`\`) 금지.

{"summary":"민원 핵심 요지", "draft":"가. ...\\n나. ...\\n다. ..."}

[summary 작성 규칙]
- 민원인이 무엇을 요청/건의/문의했는지를 한 문장(15자 이내)으로 요약
- 예시: "학교급식 위생점검 요청", "교원 복무 개선 건의", "전입학 절차 문의"
- 요약은 간결하되 원문의 핵심 주제를 정확히 담아야 한다

[draft 작성 규칙 - 매우 중요]
draft는 민원인에게 보낼 공식 답변의 "검토 의견" 본문이다.
단순 요약이나 떠넘기기 답변이 아니라, 실질적이고 구체적인 행정 답변이어야 한다.

구조:
- 가. 민원 사항에 대한 현황 파악 또는 확인 결과 (구체적 사실, 수치, 실시 내역 등)
- 나. 관련 제도·법령·절차에 대한 설명 (확실한 법령명만 사용)
- 다. 향후 조치 계획 또는 추가 안내 사항 (개선 약속, 양해 요청 등)

작성 원칙:
1. 각 항목은 3~5문장의 충분한 분량으로 작성하라
2. "~을 알려드립니다", "~하고 있습니다", "~조치하겠습니다" 같은 공문서 어투 사용
3. 민원인의 입장을 존중하는 정중한 표현 ("귀하의 소중한 의견", "깊은 관심", "노력하겠습니다")
4. 민원 내용의 요청 사항에 직접적으로 응답하라
5. 막연한 답변 금지 ("홈페이지 참고", "전화문의" 같은 떠넘기기 답변 절대 금지)
6. 확실하지 않은 법령 조문번호는 쓰지 말고, 법령명만 인용하라
7. 원문에 없는 사실을 지어내지 말되, 일반적인 행정 절차와 정책은 설명할 수 있다

[예시 - 급식 위생 민원인 경우]
{"summary":"학교급식 위생관리 개선 요청","draft":"가. 귀하께서 제기하신 급식실 위생 관련 사항에 대하여 확인한 결과, 해당 학교에서는 현재 학교급식법에 따른 위생관리 기준을 준수하여 운영 중이며, 조리실 환기시설은 정기적인 점검과 청소를 실시하고 있음을 알려드립니다. 또한 식자재 보관은 냉장·냉동 온도 기준에 따라 관리되고 있으며, 매일 조리 전 검수를 통해 품질을 확인하고 있습니다.\\n나. 우리 교육청에서는 학교급식법 및 관련 지침에 따라 연 2회 이상 정기 위생점검을 실시하고 있으며, 학교별 자체 점검과 함께 외부 전문기관을 통한 위생·안전 컨설팅도 병행하고 있습니다. 점검 결과 미흡 사항이 발견될 경우 즉시 시정 조치하고 재점검을 통해 개선 여부를 확인하고 있습니다.\\n다. 다만, 귀하의 소중한 의견을 반영하여 해당 학교에 대한 특별 위생점검을 조속히 실시하고, 환기시설 및 식자재 보관 상태를 면밀히 확인하여 미비한 사항이 확인될 경우 즉각 개선 조치하겠습니다. 앞으로도 학생들의 건강하고 안전한 급식 제공을 위해 최선을 다하겠습니다."}

반드시 JSON만 출력하라.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API 오류: ${response.status} - ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: ensureString(parsed.summary),
        draft: ensureString(parsed.draft),
      };
    }
  } catch (e) {
    throw new Error('AI 응답 파싱 실패: ' + e.message);
  }

  return { summary: '', draft: '' };
}
