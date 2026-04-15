// ═══════════════════════════════════════════════════════════════
// 국민신문고 민원답변 충실도 평가 기준 (2026. 4. 개정)
// ═══════════════════════════════════════════════════════════════

export const RUBRIC_VERSION = '2026-04';
export const MAX_SCORE = 100;
export const BONUS = 8;

// ─────────────────────────────────────────────
// 코드 검사 (정규식 / 길이) — Gemini 없이 즉시 판정
// ─────────────────────────────────────────────
export const CODE_CHECKS = {
  // 도입부 30점
  greeting: {
    points: 10,
    section: 'intro',
    label: '인사말',
    // 템플릿이 항상 '안녕하십니까'로 시작하므로 자동 통과
    check: () => ({ pass: true, pts: 10 }),
  },

  caseNumber: {
    points: 10,
    section: 'intro',
    label: '민원신청번호',
    // 폼 입력 검증 (1AA-YYYY-XXXXXXX)
    regex: /1[A-Z]{2}-\d{4}-\d{7}/,
    check: (caseNum) => {
      const ok = typeof caseNum === 'string' && /1[A-Z]{2}-\d{4}-\d{7}/.test(caseNum);
      return { pass: ok, pts: ok ? 10 : 0 };
    },
  },

  routingReason: {
    points: 10,
    section: 'intro',
    label: '이첩/기피/소극행정 사유 안내',
    // mType + 폼 입력으로 판정
    check: (mType, formData) => {
      if (mType === 'normal') return { pass: true, pts: 10, na: false };
      if (mType === 'transfer') {
        const ok = !!(formData?.fromOrg || '').trim();
        return { pass: ok, pts: ok ? 10 : 0 };
      }
      if (mType === 'avoid') {
        const ok = !!((formData?.avoidDept || '').trim() && (formData?.avoidReason || '').trim());
        return { pass: ok, pts: ok ? 10 : 0 };
      }
      if (mType === 'passive') {
        const ok = !!(formData?.passReason || '').trim();
        return { pass: ok, pts: ok ? 10 : 0 };
      }
      return { pass: true, pts: 10 };
    },
  },

  // 전개부 50점
  summary: {
    points: 10,
    section: 'body',
    label: '민원요지',
    // 따옴표 안 편집 영역이 비어있지 않으면 만점 (사용자 요청)
    check: (summaryText) => {
      const ok = typeof summaryText === 'string' && summaryText.trim().length > 0;
      return { pass: ok, pts: ok ? 10 : 0 };
    },
  },

  structure: {
    points: 20,
    section: 'body',
    label: '가독성 (구조화)',
    // 가/나/다, 1./2./3., ①②, ○ 등 2개 이상 매칭
    regex: /(?:가\.|나\.|다\.|라\.|마\.|1\.|2\.|3\.|4\.|5\.|①|②|③|④|⑤|○|●)/g,
    check: (bodyText) => {
      if (!bodyText || typeof bodyText !== 'string') return { pass: false, pts: 0 };
      const matches = bodyText.match(/(?:가\.|나\.|다\.|라\.|마\.|1\.|2\.|3\.|4\.|5\.|①|②|③|④|⑤|○|●)/g) || [];
      const uniq = [...new Set(matches)];
      const ok = uniq.length >= 2;
      return { pass: ok, pts: ok ? 20 : 0, matchedMarkers: uniq };
    },
  },

  // 종결부 20점
  contact: {
    points: 20,
    section: 'closing',
    label: '담당자 정보',
    // 부서(기관+부서), 성명, 전화번호 각 항목. 법 규정 점수표.
    check: (formData) => {
      const org = (formData?.org || '').trim();
      const dept = (formData?.dept || '').trim();
      const name = (formData?.name || '').trim();
      const phone = (formData?.phone || '').trim();

      const deptOk = org.length > 0 && dept.length > 0;
      const nameOk = name.length > 0;
      const phoneOk = phone.length > 0;
      const count = [deptOk, nameOk, phoneOk].filter(Boolean).length;

      // 2026.4 규정: 2가지=14, 1가지=8, 0=0
      // 3가지 전부 입력 시 만점 20점 부여 (의무사항)
      let pts = 0;
      if (count >= 3) pts = 20;
      else if (count === 2) pts = 14;
      else if (count === 1) pts = 8;

      return {
        pass: count > 0,
        pts,
        detail: { deptOk, nameOk, phoneOk, count },
      };
    },
  },

  // 가점 8점
  satisfaction: {
    points: 8,
    section: 'bonus',
    label: '만족도 참여 유도',
    // 체크박스 기반
    check: (surveyEnabled) => {
      const ok = surveyEnabled === true;
      return { pass: ok, pts: ok ? 8 : 0 };
    },
  },
};

// ─────────────────────────────────────────────
// 감점 항목 — 전개부 '성실한 답변' 20점 기본에서 차감
// ─────────────────────────────────────────────
export const SINCERITY_BASE = 20;

export const AI_DEDUCTIONS = {
  // Gemini가 판정
  privacy: {
    penalty: -20,
    label: '제3자 개인정보·영업비밀',
    desc: '답변에 필요하지 않은 제3자의 개인정보, 영업상 비밀 등을 포함했는지',
    examples: [
      '김OO 주민등록번호 xxxxxx-xxxxxxx',
      '특정 학부모/학생의 이름과 신상 포함',
      '업체의 영업비밀 공개',
    ],
  },

  jurisdiction: {
    penalty: -10,
    label: '소관 아님 안내 누락',
    desc: '소관 아님을 안내할 때 이유/소관기관 정보/처리방법 중 하나라도 누락',
    examples: [
      '"저희 소관이 아닙니다"만 쓰고 어디로 가라는 안내 없음',
      '소관기관은 알려주지만 처리방법 설명 없음',
    ],
  },

  passBuck: {
    penalty: -10,
    label: '떠넘기기 답변',
    desc: '다른 부서/기관으로 민원처리를 미루거나 책임 떠넘기기, 제3자와 갈등 유발',
    examples: [
      '"자세한 사항은 해당 부서로 문의"',
      '"직접 OO과로 연락하시기 바랍니다"',
      '담당자 정보 안내를 제외한 책임 전가',
    ],
    // 정규식 1차 필터 (주의: 종결부 담당자 안내와 구별)
    // 본문 안에 있을 때만 감점
    preFilter: /(?:해당\s*부서.*?(?:문의|연락)|직접\s*(?:문의|연락)|자세한\s*(?:사항|내용).*?문의\s*하시|OO과로\s*연락|담당자에게\s*직접)/,
  },

  refOnly: {
    penalty: -10,
    label: '기존 답변 참고 안내',
    desc: '요구 수용 없이 기존 답변/전화 등을 참고하라고 안내 (첨부한 경우 제외)',
    examples: [
      '"이전 답변을 참고해주세요"',
      '"홈페이지에서 확인하세요"',
      '"전화로 문의 바랍니다"',
    ],
    preFilter: /(?:이전\s*답변.*?참고|기존\s*답변.*?참고|홈페이지.*?(?:참고|확인)|전화.*?(?:문의|안내))/,
  },
};

// ─────────────────────────────────────────────
// 협조민원 자가 체크리스트 (-30)
// ─────────────────────────────────────────────
export const COOPERATION_CHECKLIST = {
  penalty: -30,
  label: '협조민원 답변 처리',
  items: [
    {
      id: 'included',
      text: '협조기관의 답변을 본문에 포함하였습니다',
    },
    {
      id: 'integrated',
      text: '단순 나열이나 복붙이 아닌 종합정리 형태로 재구성하였습니다',
    },
    {
      id: 'adapted',
      text: '민원인의 질문에 맞추어 자연스럽게 녹여냈습니다',
    },
  ],
  // 모두 체크하면 0, 하나라도 미체크면 -30
  evaluate: (checked) => {
    if (!checked) return { pts: 0, na: true };
    const allChecked = ['included', 'integrated', 'adapted'].every((k) => checked[k]);
    return {
      pts: allChecked ? 0 : -30,
      pass: allChecked,
      missing: ['included', 'integrated', 'adapted'].filter((k) => !checked[k]),
    };
  },
};

// ─────────────────────────────────────────────
// 전체 점수 계산 (Phase 1 + Phase 2 결과 병합)
// ─────────────────────────────────────────────
export function calcTotalScore({ codeResults, aiResults, cooperation }) {
  let total = 0;
  const sections = { intro: 0, body: 0, closing: 0, bonus: 0 };

  // 코드 검사 합산
  for (const [key, result] of Object.entries(codeResults || {})) {
    const def = CODE_CHECKS[key];
    if (!def) continue;
    total += result.pts;
    sections[def.section] = (sections[def.section] || 0) + result.pts;
  }

  // 전개부 '성실답변' 20점 기본 + AI 감점
  let sincerity = SINCERITY_BASE;
  const aiDeducts = [];
  if (aiResults) {
    for (const [key, r] of Object.entries(aiResults)) {
      const def = AI_DEDUCTIONS[key];
      if (!def) continue;
      if (r.triggered) {
        sincerity += def.penalty; // penalty는 음수
        aiDeducts.push({ key, ...r, label: def.label, penalty: def.penalty });
      }
    }
  }
  sincerity = Math.max(0, sincerity);
  total += sincerity;
  sections.body += sincerity;

  // 협조민원 감점
  let coopPts = 0;
  if (cooperation && cooperation.enabled) {
    const r = COOPERATION_CHECKLIST.evaluate(cooperation.checked);
    coopPts = r.pts;
    total += coopPts;
  }

  // 총점 하한 0
  total = Math.max(0, total);
  // 가점 제외 상한 100, 가점 포함 108
  return {
    total,
    sections,
    sincerity,
    aiDeducts,
    cooperation: { pts: coopPts, enabled: cooperation?.enabled },
  };
}

// ─────────────────────────────────────────────
// 민원 유형 (mType)
// ─────────────────────────────────────────────
export const M_TYPES = {
  normal: '일반 민원',
  transfer: '이첩 민원 (대통령비서실/규제신문고)',
  avoid: '기피신청 민원',
  passive: '소극행정 신고 민원',
};
