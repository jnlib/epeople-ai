# 민원봇 AI v2 — 배포 & 테스트 가이드

## 🔖 백업 상태

- **v1 태그**: `v1-stable` (push 완료, 언제든 `git checkout v1-stable`로 롤백 가능)
- **v2 브랜치**: `v2-law` (현재 작업 브랜치, 이미 push 완료)
- **v1 Worker**: `icy-art-4e14.hdh1231.workers.dev` (그대로 살아있음)
- **v2 Worker**: `epeople-ai-v2.hdh1231.workers.dev` (배포 대기 중)
- **v1 프론트**: main 브랜치 → GitHub Pages (그대로 살아있음)
- **v2 프론트**: v2-law 브랜치 → 로컬 테스트 먼저, 검증 후 merge

## ⚙️ 1단계: Cloudflare Worker 배포

```bash
cd worker
# 1) Gemini API 키 주입 (기존 키 재사용 시도)
wrangler secret put GEMINI_API_KEY
# 프롬프트 나오면 키 붙여넣기 후 엔터
# (실패 시 새 키 발급 → https://aistudio.google.com/apikey)

# 2) 워커 배포
wrangler deploy
# 첫 배포 후 출력되는 URL 확인:
#   https://epeople-ai-v2.hdh1231.workers.dev

# 3) 헬스체크
curl https://epeople-ai-v2.hdh1231.workers.dev/api/health
# 응답 예시:
# {"status":"ok","service":"epeople-ai-v2","version":"2026-04","geminiKey":true}
```

## 💻 2단계: 로컬 테스트 (권장)

```bash
# 프로젝트 루트에서
python -m http.server 8000
# 브라우저: http://localhost:8000/

# 또는 Live Server 확장 사용
```

테스트 시나리오:

1. **일반 민원 테스트**
   - 민원 원문 붙여넣기: "학교 급식실 위생이 걱정됩니다. 점검해주세요."
   - 민원 유형: 일반 민원
   - 담당자 정보: 임의 입력 + 민원번호 `1AA-2604-1234567`
   - 초안 생성 → 법령 탭에 학교급식법/학교보건법 등 나오는지 확인

2. **편집 재채점 테스트**
   - 본문에 "자세한 사항은 해당 부서로 문의하시기 바랍니다" 추가
   - 2초 후 성실답변 점수가 20 → 10으로 내려가는지 확인

3. **협조민원 테스트**
   - 폼에서 협조민원 체크
   - 결과 화면 하단에 자가 체크리스트 3개 나타나는지
   - 체크 시 -30 → 0으로 바뀌는지

4. **법령 무관 민원**
   - "선생님 감사합니다" 같은 감사 민원
   - 법령 탭에 "법령 근거가 필요하지 않습니다" 메시지

5. **전체 복사 테스트**
   - 📥 전체 복사 버튼 → 클립보드 확인

## 🚀 3단계: 검증 후 main 머지 (선택)

v2가 만족스러우면:

```bash
git checkout main
git merge v2-law
git push origin main
# GitHub Pages가 자동 재배포
```

main에 머지해도 v1은 `v1-stable` 태그로 언제든 복원 가능:

```bash
# v1 복원이 필요한 경우
git checkout v1-stable -- index.html worker/
git commit -m "Revert to v1"
git push
```

## 📊 비용 예상

| 처리량 | Gemini 호출 | 월 비용 |
|--------|:-:|:-:|
| 100건/월 | ~600회 | ~300원 |
| 1,000건/월 | ~6,000회 | ~3,100원 |
| 10,000건/월 | ~60,000회 | ~31,000원 |

## 🛠️ 파일 구조

```
epeople-ai/ (v2-law 브랜치)
├── index.html              # 전체 UI (폼 + 결과 탭 3개)
├── worker/
│   ├── worker.js           # 4개 엔드포인트 + 법령 파이프라인
│   ├── rubric.js           # 루브릭 정의 + 코드검사 + AI감점 항목
│   └── wrangler.toml       # v2 워커 이름 epeople-ai-v2
├── V2_README.md            # 이 파일
└── .github/workflows/pages.yml
```

## ⚠️ 주의사항

1. **민원번호 형식**: `1AA-YYYY-XXXXXXX` (첫 3글자 = 기관코드)
2. **협조민원**: 자가 체크리스트 3개 모두 체크해야 감점 없음 (-30)
3. **법령 인용**: AI가 제안한 법령만 프롬프트에 포함, 환각 차단
4. **약칭 처리**: eflaw → aiSearch 폴백으로 자동 커버 (수동 맵 없음)
5. **Cache TTL**: eflaw/aiSearch 1시간, lawService 24시간

## 🐛 트러블슈팅

### "GEMINI_API_KEY 없음" 에러
```bash
cd worker && wrangler secret put GEMINI_API_KEY
```

### 법령이 하나도 안 나옴
- 민원 원문이 너무 짧거나 추상적일 수 있음
- 법제처 API 일시 장애일 수 있음 → `curl "https://www.law.go.kr/DRF/lawSearch.do?OC=hdh1231&target=aiSearch&type=JSON&query=학교급식&search=0&display=3"`
- Cloudflare 에러 525 (법제처 SSL) → 잠시 후 재시도

### 채점 정확도 이슈
- Gemini temperature 0.1로 고정 (worker.js 수정으로 0.0 가능)
- 감점 evidence 확인 → 원문 인용이 안 맞으면 오판정 가능성
- 자주 오판정되는 패턴은 rubric.js의 preFilter 정규식 보강

### 본문 편집해도 재채점 안 됨
- debounce 2초 대기 필요
- 브라우저 개발자도구 Console에서 fetch 에러 확인
- 워커 URL이 index.html의 `WORKER` 상수와 일치하는지 확인
