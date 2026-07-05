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

---

## 2026-07-02 업데이트 3: 화면 인식 v2 (템플릿 매칭)

- 구식 픽셀 임계값 방식(제거됨) 대신 **NCC 템플릿 매칭**으로 재구현. OLD_CAPTURE 주석 블록 → `ttv*` 모듈로 교체
- 템플릿: `public/image/tt/` g1~g6·r1~r6 (48×48, IMG_3589에서 추출, 빨강 3·5는 재염색 합성). 눈1 = 새싹 아이콘
- 게임 화면 규칙: 눈 색 = 소유자(초록=나/빨강=상대, 상대 필드 위 내 실드도 초록 눈), **실드 = 주사위 개별 초록/빨강 링**, 상대 필드의 내 주사위도 그 라인 점수·더블에 포함
- 기준 지오메트리(1052×593): 내 칸 x[263,344,425] 상대 x[592,673,754] 행 y[215,306,396] S=48, 내 트레이 (150,307), 상대 트레이 (867,307 추정)
- 2클릭 보정(내L1S1 중심 → 상대L3S3 중심) → 균등 스케일 변환, localStorage `tt_calib_v2`
- 스캔 1.2초, **2회 연속 동일 스냅샷일 때만 커밋**, NCC<0.45 칸은 기존 값 유지, 트레이는 실드 판정 제외(초록 펠트 오탐)
- 커밋: 보드 전체 덮어쓰기 + 내 트레이 주사위 → TT.cur/턴 자동. AI 대전 중엔 스캔 무시
- 검증: 기준 스크린샷 20/20, 0.448배 스케일 교차 테스트 19/20(전 칸 정확, 트레이 실드 오탐 → 수정됨)
- 한계/TODO: 상대 트레이 좌표는 미검증(추정), 타짜 두 번째 주사위 위치 미지원, 알까기 보상 실드 굴림은 수동 입력

---

## 티카투카 PvP — 구현 완료 (2026-07-05)

**구현 위치**
- server.js: `createTikaState`, `ttLaneScore/ttScores/ttColorFull/ttDone`, `ttEmitState`(개인화 me/opp), `ttAdvance`, `ttFinish`, `startTikaGame`. 핸들러 `tt:place / tt:reroll / tt:choose / tt:hold / tt:placeBonus`. start_game·rematch·create_room·createRoom에 tikatuka 분기, useTimer=false.
- index.html: 방만들기 모달 라디오 '🎲 티카투카', 전용 화면 `#tt-pvp-screen`, 클라 모듈 `TTP`/`ttPvp*` (렌더러는 기존 `ttDieFaceSVG`·`.tt-*` CSS 재활용, 훈수/화면인식 없음). game_start·spectate_start·game_over·room_list·lobby에 tikatuka 분기, `socket.on('tt:state')`.

**검증 완료**: 점수(단1·더블3·트리플5), 알치기(양측 비실드 동값 제거), 실드 면역(알치기 불가/대상 아님), 종료(양쪽 만석/홀드, 2라인 즉시종료 없음), 홀드(한쪽 홀드→상대 9개까지), 승자(라인수→총점) — 로직 시뮬 21케이스 통과.
**남은 확인**: 실제 2인 접속 스모크 테스트(`node server.js` 후 두 브라우저).

**UI 개편 (2026-07-05)**: 어드바이저와 동일한 가로형 라인 보드로 교체 — 좌(내 3슬롯) | 중앙(점수 vs·라인명·우세표시) | 우(상대 3슬롯), `.tt-lane`/`.tt-dice-row`/`.tt-lane-score` CSS 재활용. 보드 위 닉네임 라벨(`#ttp-head-me/opp`, 현재 턴 🎲 표시). 주사위 모션: 굴림 애니메이션(`ttpRollAnim` — 눈 랜덤 순환 후 착지, 내/상대/보너스/리롤 모두), 배치 팝(`ttp-pop`), 알치기 제거 💥(`ttp-boom-fx`) — 이전 스냅샷(`TTP.snap`) 비교로 감지. 상대 굴림도 주사위 실물 표시. jsdom 스모크 7상태 + pop/boom/click emit 검증 통과.

**UI 개편 2차 (2026-07-05)**:
- **안쪽 압축 정렬** `ttpCompactRow(row, side)`: 서버는 0번 슬롯부터 채우고 알치기 시 구멍이 남지만, 표시용으로 압축 — 내 필드(좌)는 중앙 쪽(오른쪽)부터, 상대 필드(우)는 왼쪽부터. 첫 배치 주사위가 맨 안쪽. 배치·보너스 emit은 lane 단위라 표시 순서 자유. 스냅샷(pop/💥 감지)도 표시 위치 기준.
- **명칭**: '리롤' → '타짜의 손놀림' (버튼·툴바 태그·상태 배너).
- **확대**: `#ttp-wrap` max-width 920px, PvP 슬롯 68px(모바일 48px), 점수 1.4rem, 굴림 주사위 60px.
- **채팅**: `#ttp-chat-box` (lanes 아래), `ttpSendChat()` — 기존 `chat` 이벤트 재활용, `addChat`이 tt-pvp-screen 활성 시 `#ttp-chat-messages`로 라우팅. 나가기 시 클리어.
- **알치기 연출 강화**: 서버 `event:'alchigi'`에 `val`(터진 눈) 추가 (server.js tt:place). 클라: 중앙 토스트 `#ttp-alchigi-toast`("💥 알치기!" + 시점별 문구, 1.6s), 해당 라인 흔들림+빨간 플래시(`.ttp-hit`), 💥 이펙트 확대(2rem·0.9s). `delete s.event`로 재렌더 중복 방지, `ttpResetAnim`에서 토스트 정리.

**판돈(베팅) 시스템 (2026-07-05)** — 원래 스펙 '베팅 없음'에서 변경:
- 방 만들기 모달: 티카투카 선택 시 판돈 픽커 `#modal-ttbet-row` (무료/1천/5천/1만/5만/10만, `selectedTtBet`). 기존 `selectBuyIn`류 셀렉터를 `#modal-buyin-row` 스코프로 변경 (ttbet 옵션과 충돌 방지).
- 서버: `room.ttBet`(0~100만 sanitize), 홀덤 바이인식 에스크로 — `ttEscrowBets`(시작/재대결 시 양쪽 차감, 부족 시 환불+취소), `ttSettleBets`(승자 2배 독식/무승부 반환, `ttEscrow` 플래그로 중복 정산 방지), `ttPushCoins`(coins_info 푸시). 정산 지점: ttFinish·handleLeaveRoom(탈주=상대 독식)·resign. 재대결 부족 시 `tt:rematch_failed`.
- 표시: room_list·lobby_state에 ttBet, 대기실 서브텍스트, PvP 점수바 VS 아래 `#ttp-bet-tag`(tt:state의 `bet`), 결과 오버레이에 ±코인 문구.

### (원래 스펙) 확정 스코프

### 확정 스코프
- 훈수(엔진 추천): PvP에서 숨김. 스킬: 리롤 1회 + 홀드 포함. 베팅 없음.
- **실드(확정)**: 자유 지정 불가. 실드 주사위는 오직 두 경우만 — ① 선공자의 첫 주사위(무조건 실드, 자기 필드만), ② 알치기 보상 주사위. 일반 굴림은 실드 아님. → PvP에선 실드 토글 버튼 제거.
- **리롤/타짜(확정)**: 게임당 1회. 2개 굴려 택1(원래 눈 + 새 눈 중 선택). tt:reroll→서버가 두 번째 눈 통지→tt:choose(idx 0/1).
- **타이머(확정)**: 티카투카 PvP는 턴 타이머 없음(useTimer=false, startTurnTimer 미호출).

### 설계
- `gameType`에 'tikatuka' 추가 (방 만들기 모달 라디오: 오목/오델로/티카투카)
- **서버 권한**: 주사위 굴림·배치 검증·알까기·보상 실드 굴림 전부 server.js에서 처리
  - 방 상태: lanes[2][3][] ({v,s}), turn, rerollUsed[2], held[2], phase, 선공 랜덤(첫 주사위 실드·자기 필드만)
  - 이벤트: tt:state(전체 동기화), tt:place(lane), tt:reroll → tt:choose(idx), tt:hold, tt:placeBonus(side,lane)
  - 알까기 룰 = 어드바이저와 동일(공격 주사위도 제거 + 보상 실드는 서버가 굴려 값 통지, 양쪽 필드 배치 가능)
  - 종료(확정): **2라인 선점 즉시종료 없음**. 양쪽 모두 '만석 또는 홀드' 상태가 되면 종료 → 라인 다수 → 동률 시 총점
  - 홀드(확정): 양쪽 모두 사용 가능. 한쪽이 홀드하면 상대는 홀드하지 않는 한 계속 배치(9개까지). 홀드 = 남은 턴 전체 포기
  - ※어드바이저 AI배틀의 2라인 즉시종료(earlyEnd)는 인게임과 다름 → PvP에는 적용 금지, 추후 배틀 모드도 인게임 룰로 수정 검토
- **클라**: 기존 어드바이저 보드 렌더러(ttDieFaceSVG 등) 재활용한 room 내 대전 화면, 훈수/화면인식 패널 숨김, 기존 turnTimer 재활용, 탈주/재접속은 오목 방식 따름
- 시작 방법: 이 섹션 + '새 세션에서 작업 시작하는 법' 참고
