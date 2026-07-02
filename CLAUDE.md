# 오목 온라인 + 티카투카 어드바이저 — 프로젝트 컨텍스트

## 기본 정보
- **GitHub**: https://github.com/leesubin3546-creator/omok-online
- **배포 URL**: https://omok-online-mss1.onrender.com
- **로컬 작업 폴더**: `C:\Users\GRAVITY\omok`
- **스택**: Node.js + Express + Socket.io (server.js), 순수 HTML/CSS/JS (public/index.html)
- **배포**: Render (수동 Deploy 또는 git push 후 대시보드에서 "Deploy latest commit")

## 파일 구조
```
omok/
├── server.js          # 서버 (오목, 홀덤, 재화/출석 로직)
├── public/
│   └── index.html     # 모든 UI (오목, 홀덤, 티카투카 어드바이저)
├── CLAUDE.md          # 이 파일
└── package.json
```

## Git 작업 방법
Claude는 VM에서 GitHub 인증 불가 → **사용자가 CMD에서 직접 push**
```cmd
cd C:\Users\GRAVITY\omok
git add public/index.html
git commit -m "메시지"
git push origin main
```
Render 배포는 Claude가 Chrome MCP로 대시보드에서 처리 가능.

---

## 구현된 기능 목록

### 0. (제거됨) 티카투카 LLM 프록시 — `/api/tikatuka-analyze`, buildPrompt 삭제 (2026-07-02, 로컬 엔진으로 대체)

### 1. 재화 시스템 (server.js)
- 골드/젬 통화, 출석 체크 (하루 1회, 500골드)
- 엔드포인트: POST `/api/attendance`, GET `/api/balance/:userId`

### 2. 홀덤 미니게임 (server.js + index.html)
- 텍사스 홀덤 (2~6인), 족보 판정, 베팅 로직
- `#holdem-section` 영역

### 3. 티카투카 어드바이저 (index.html 전용, 서버 불필요)

---

## 티카투카 어드바이저 — 상세 명세

### 개요
로스트아크 미니게임 "티카투카" 실시간 분석 도우미.  
화면 공유(getDisplayMedia)로 게임 화면을 캡처해 주사위를 자동 인식하고 최적 수를 추천.

### UI 레이아웃
- 좌상단: 내 주사위 입력 (SVG pip 다이스, 실드 체크박스)
- 우상단: 타짜 추가주사위 / 스킬 상태
- 중앙: 3라인 보드 (내 3슬롯 | 점수 | 상대 3슬롯)
- 하단: 최적수 추천 패널
- 우측 패널: 화면 참조 (캡처 캔버스), 현황

### 색상 테마 (사이트 통일)
```css
--bg: #f5ede0
--surface: #ede0cc
--card: #e0cfa8
--border: rgba(140,100,50,0.22)
--accent2: #c8881a
--text: #2a1805
--text2: #7a5828
```

### 주사위 데이터 모델
```javascript
TT_EMPTY_DIE = () => ({v:0, s:false, blown:false})
// v: 값 0-6, s: 실드여부, blown: 날아간(알치기당한) 여부
```

### 주요 함수
| 함수 | 역할 |
|------|------|
| `ttAutoCalib(ctx, W, H)` | 화면 비율로 보드 좌표 자동계산 |
| `ttReadDie(ctx, cx, cy, dw, dh, side)` | 단일 주사위 픽셀 분석 → {v, s} |
| `ttDetectDice(ctx, W, H)` | 보드 전체 9×2 주사위 감지 |
| `ttDetectCurrentDie(ctx, W, H)` | 굴린 주사위 최대 2개 반환 (배열) |
| `ttLaneScore(dice)` | 라인 점수 계산 (blown 제외) |
| `ttEvalMove(die, laneIdx)` | 수 평가: 알치기/실드충돌/라인역전 |
| `ttAnalyze()` | 전체 추천 계산 및 렌더 |
| `ttDrawDebugOverlay(ctx, detected, currentDice)` | 감지 영역 오버레이 |

### 화면 인식 좌표 (1920×1080 기준)
팝업 offset (317, 136), 스케일 1.0625×1.126 적용값:
```javascript
myX1    = 653   // 내 보드 좌변
myX2    = 922   // 내 보드 우변
oppX1   = 1017  // 상대 보드 좌변
oppX2   = 1282  // 상대 보드 우변
boardY1 = 448   // 보드 상단
boardY2 = 750   // 보드 하단
dieX1   = 353   // 굴린주사위 판자 좌변 (cx=(353+653)/2=503)
splitX  = 969   // 스코어 컬럼 중심
```
코드에서 `sx = W/1920`, `sy = H/1080`으로 자동 스케일.

### pip 감지 색상 함수
```javascript
ttIsCream(r,g,b)    // 주사위 배경: r>175 && g>155 && b>110 && r>b+20
ttIsGreenPip(r,g,b) // 내 눈금: g>80 && g>r*1.4 && g>b*1.3 && r<155 && b<155
ttIsRedPip(r,g,b)   // 상대 눈금: r>130 && r>g*1.7 && r>b*1.8 && g<110 && b<100
```
샘플 패치: 7×7 (radius=3), 임계값 0.18.  
다이 값 패턴: TL/TR/ML/MC/MR/BL/BR 7점 → 1~6 매칭, 폴백 비율 추정.

### 알치기 / 실드 로직
- **알치기**: 내가 V를 놓을 때 상대의 비실드 V 주사위가 날아감
- **실드 충돌**: 내 비실드 V가 상대 실드 V에 부딪히면 내 주사위가 날아감 (`hitsShield`, priority -50)
- 실드 주사위도 알치기 가능 (`!die.s` 조건 제거됨)
- 날아간 주사위: 더블클릭 토글 (`blown:true`), 점수 제외

### 타짜의 손놀림 지원
`ttDetectCurrentDie`가 배열 반환 → `[cur, sec]` 자동 적용.  
두 번째 주사위는 `TT.sec`에 반영되어 추천에 포함.

---

## 알려진 이슈 및 TODO
- [ ] 화면 인식 오탐 간헐적 발생 (pip 색상 임계값 미세조정 필요)
- [ ] 게임 창 캡처 시 해상도 불일치 주의 (게임 창만 공유 권장)
- [ ] 수동 캘리브레이션: "보드 위치 재설정" 버튼 → 클릭 두 번으로 보정 가능
- [ ] Render 무료 티어: 첫 요청 시 콜드 스타트 30~60초 지연

---

## 새 세션에서 작업 시작하는 법
1. 이 파일(CLAUDE.md) 내용을 Claude에게 보여주거나 파일 경로를 알려줌
2. `C:\Users\GRAVITY\omok\public\index.html` 파일 읽기 권한 부여
3. 작업 후 사용자가 CMD에서 `git push origin main` 실행
4. Claude가 Chrome MCP로 Render 배포 처리

---

## 2026-07-02 업데이트: TT_ENGINE (로컬 expectimax 탐색 엔진)

### 개요
티카투카 AI를 LLM API 의존에서 **로컬 탐색 엔진**으로 교체. index.html 내 `TT_ENGINE` (IIFE).
- 3수 깊이 expectimax: 주사위 눈 확률(1/6) 기대값 전개 + 상대 최선 응수
- 평가 함수: 남은 슬롯 기대점수 투영 + 더블/트리플 기대 보너스 - 알치기 취약도 → 라인별 승률 → P(2라인 이상)
- 이 앱 룰 그대로 반영: 알치기 시 공격 주사위도 제거, 보너스 실드 양쪽 필드 배치, 배틀 모드 2라인 선점 즉시 종료(earlyEnd)
- 속도 ~130ms/수 (depth 3, budget 120k), 서버/API 불필요

### 변경점
| 위치 | 내용 |
|------|------|
| `#tt-ai-provider` | 드롭다운 제거 — 로컬 엔진 단일화 |
| `TT_ENGINE` | 신규 엔진 (ttLaneResults 뒤). API: fromTT, rateMoves, bestOf, rateBonusSpots, rerollAdvice |
| `ttAnalyze` | 추천 영역을 엔진 기반 라인별 승률 바(%)로 교체 (`ttEngineRecoMain/Bonus`), 타짜 리롤 추천 표시 |
| `ttAskClaude` | `ttLocalRecommend()` 로컬 계산 전용 (fetch 제거) |
| `ttAiBattleTurn` | API 호출 제거 → 엔진 직접 사용 (시점 뒤집기 불필요) |
| `ttAiBattleBonusTurn` | 엔진 스팟 선택 + 보너스 실드 눈 랜덤화 (기존 최적값 치팅 제거) |

### 검증 (jsdom + 순수엔진 대량 시뮬)
- 추천/배치/알치기/보너스/배틀 전 플로우 JS 에러 0
- 엔진 vs 완전랜덤 2000판(선공 교대): 승률 82.2% — 룰 특성상(주사위 운) 사실상 상한
- 강화 실험 결과: depth 4+/파라미터 변형 전부 자가대전 46~50%로 무익 → depth 3 + 종반(빈칸≤6) 완전해석 + 국면 캐시가 최종 구성
- 속도: 초반 ~15ms, 중반 ~50ms, 종반 ~0.8s

### 주의
- `ttEvalMove`, `ttBestBonusVal`은 잔존 (일부 경로에서 사용), 추천 본선은 엔진
- 대용량 index.html 편집 시 파일 끝 잘림 사고 발생 이력 → 편집 후 `</html>` 존재 및 파일 크기 확인 권장

---

## 2026-07-02 업데이트 2: 포링 돌 디자인

- 돌 디자인 픽커에 **포링** 스타일 추가 (오목·오델로 공용)
- 흑(1) = 원본 핑크 포링, 백(2) = 포포링(파랑, hue +225° 변환 생성)
- 이미지: `public/image/poring.png`, `public/image/poporing.png` (root `image/`의 원본은 보존)
- `drawStoneOnCtx`에 poring 분기 (이미지, 높이 2.3r) + 로드 전 폴백 원형(STONE_COLORS.poring)
- `drawOthelloStone`이 흑백 고정 → 픽커 스타일 공용(`drawStoneOnCtx`)으로 변경
