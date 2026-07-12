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

## 2026-07-02 업데이트 2: 포링 돌 디자인 → (2026-07-06 굿코코로 교체됨)

- 돌 디자인 픽커에 **포링** 스타일 추가 (오목·오델로 공용)
- 흑(1) = 원본 핑크 포링, 백(2) = 포포링(파랑, hue +225° 변환 생성)
- 이미지: `public/image/poring.png`, `public/image/poporing.png` (root `image/`의 원본은 보존)
- `drawStoneOnCtx`에 poring 분기 (이미지, 높이 2.3r) + 로드 전 폴백 원형(STONE_COLORS.poring)
- `drawOthelloStone`이 흑백 고정 → 픽커 스타일 공용(`drawStoneOnCtx`)으로 변경

### 2026-07-07: 도화가 추가 — 블루퍼플 변형 폐기
- 파란 색변형(goodcoco2)이 어색하다는 피드백 → `image/i0177680165.gif`(도화가 치비, GIF 1000×1000)에서 첫 프레임 추출 후 누끼(테두리 플러드필, 단일 컴포넌트) → **`public/image/goodcoco2.png` 교체** (296×370, 긴 변 370px로 축소)
- 스킨 구성: 플레이어1 = 모코코(초록, goodcoco.png 그대로), 플레이어2 = 도화가. 표시명 '굿코코'→'모코코' (STYLE_NAMES·픽커), 스킨 id/상점 키는 'goodcoco' 유지(보유 데이터 호환). 폴백 c2 색상을 크림톤으로 변경
- node-canvas는 GIF 첫 프레임 로드 가능 확인. 검증: 보드 2종 위 돌 크기 렌더 OK

### 2026-07-06: 포링 → 굿코코 교체 (프리미엄 100만)
- `image/Goodcoco.png`(초록 새싹 캐릭터) 누끼: 테두리 플러드필 배경 제거 + 최대 컴포넌트만 유지 + 말풍선("굳!") 구역 지우개 마스크(머리 외곽선 우측 여백 기준, 말풍선 꼬리가 캐릭터와 연결돼 있어 필요) → `public/image/goodcoco.png` (288×365)
- 변형색: 초록 계열 hue만 +165° 회전(볼터치 핑크·외곽선 유지) → `goodcoco2.png` (블루퍼플). 처리 스크립트는 스크래치패드(재실행 시 image/Goodcoco.png 원본에서 재생성 가능)
- 코드: PORING_IMGS→GOODCOCO_IMGS, drawStoneOnCtx 분기 교체, ALL_STYLES/STYLE_NAMES poring→goodcoco('굿코코'), **PREMIUM_SKINS에 추가 + SHOP_SKINS goodcoco: 1000000**, 픽커 🔒 프리미엄 슬롯, localStorage 'poring' 저장값은 classic으로 마이그레이션
- 검증: node-canvas로 오목/오델로 보드 위 돌 크기 렌더 확인, jsdom 스모크 회귀 없음

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

## 2026-07-06 업데이트: 코인 활용 4종

**① 오목·오델로 판돈**: `room.ttBet`을 홀덤 외 전 게임으로 확장. 시작/재대결 시 `ttEscrowBets`, 모든 종료 지점(오목 승/무, 오델로 종료, 타임아웃, 기권 수락, resign, 탈주)에서 `settleGameBets` 호출 + game_over에 `ttBet`. 모달 판돈 픽커는 홀덤 외 전 게임 노출.

**② 관전자 승부 예측**: 관전자가 승자 예측 베팅(100~10만, 게임당 1회, 즉시 차감). 컷오프: 오목 10수·오델로 돌14개·티카투카 주사위 6개 이내. 적중 2배/무승부 반환 — `settlePredictions`(settleGameBets에 포함), `room.predictions`. 이벤트: predict_bet/predict_ok/predict_error/predict_result. 클라: 우하단 고정 `#predict-panel`(관전 진입 시 표시), 베팅 시 방 채팅에 공지.

**③ 돌 스킨 상점**: 프리미엄 스킨 gold(50만)/neon(50만, 글로우)/gem(100만, 다이아 컷) — `PREMIUM_SKINS`, 픽커에 🔒, 미보유 클릭 시 상점 오픈. 스키마 `ownedSkins`. 구매 즉시 자동 선택.

**④ 닉네임 치장**: 칭호(🎲30만/🔥30만/💎100만/👑300만, `equippedTitle`)·닉 색상(5색 각 20만, `nickColor`). 적용 위치: 채팅(서버가 `style` 첨부, `nickStyleCache`), 오목 플레이어 카드, 티카투카 PvP 이름. 카드 전적 갱신은 endsWith 비교로 변경(칭호 접두어 대응).

**공통**: 상점 모달 `#shop-modal`(탭 3개, 카탈로그는 서버 shop_info가 전달 — 가격 단일 소스), 이벤트 shop_info/shop_buy/shop_equip/shop_result. 로비 돌 디자인 카드에 🛒 상점 버튼. jsdom 스모크: 상점 렌더/잠금/선택차단/채팅 스타일 통과.

## 2026-07-06 업데이트 2: 체스 (gameType 'chess')

- **서버**: `chess.js@1.4` 의존성 추가(require CJS). `room.chess = new Chess()`, `buildChessState/chessEmitState`(board 매핑 `[0][0]`=a8, turn 'w'/'b', 합법수 verbose, inCheck, lastMove). 핸들러 `chess:move`(from/to, **프로모션 퀸 자동**, 불법 수 try/catch). 체크메이트=승, 스테일메이트·기물부족·3회반복·50수=무승부 → settleGameBets+game_over. start_game/rematch/관전 join에 chess 분기, `place_stone`은 gomoku 전용으로 가드 강화(board null 크래시 방지). color 1=백(선공), room.turn 유지로 기존 타이머/타임아웃 그대로 동작.
- **클라**: 기존 game-screen 캔버스 재활용(오델로 8x8 지오메트리 공유). `drawChessBoard`(체크무늬+유니코드 기물 — 백은 밝은 채움+외곽선, 파일/랭크 라벨, 마지막 수/선택/체크 킹 강조, 이동 가능 점·잡기 링), `chessClick`(선택→합법 타겟 필터→emit), **흑 플레이어는 보드 자동 뒤집기**(`chessFlipped`), 관전자는 백 시점. 상태바 ♙백/♟흑 + '🔴 체크!', 플레이어 카드 킹 아이콘+백/흑 배지. 판돈·예측(10수 컷오프)·재대결·탈주 정산 전부 기존 인프라로 연동.
- **검증**: chess.js 가정 11케이스(매핑/폴스메이트/스테일메이트/캐슬링/앙파상/프로모션/불법수 throw) + 클라 jsdom 8케이스(렌더/선택/이동 emit/흑 뒤집기/상대 기물 차단) 전부 통과. 기존 티카투카·상점 스모크 회귀 없음.
- **기물 퀄업 (2026-07-06)**: 유니코드 글리프 → 자체 벡터 스프라이트로 교체. `chessBodyPath`(기물별 실루엣 패스, 100×100 좌표계)+`chessDetailPath`(눈/갈기/왕관 구슬 등)+`chessPieceSprite`(2배 슈퍼샘플 오프스크린 캐시 `CHESS_SPRITES`). 그라디언트 채움(백 아이보리/흑 다크브라운), 림 라이트(흑 기물 어두운 칸 분리), 바닥 그림자. 흑 나이트 좌우반전(마주봄). 플레이어 카드 킹 아이콘도 스프라이트. node-canvas로 12기물 렌더 시각 검증 완료. CHESS_GLYPHS는 잔존(미사용 가능).
- **주의**: Render 배포 시 `npm install` 필요 (package.json에 chess.js 추가됨).

**주사위 수정 (2026-07-06)**:
- 타짜의 손놀림 두 번째 눈 = `ttRollExcept(cur.v)` — 원래 눈 제외 5개 중 균등 (1..5 굴려서 exclude 이상이면 +1).
- `ttRoll`을 `Math.ceil(random()*6)` → `Math.floor(random()*6)+1`로 교체 (ceil은 random()===0일 때 0 반환 → 빈 주사위 취급 버그, 확률 2^-53).
- 검증: 6백만회 카이제곱 9.43(df=5, 임계 11.07) 균등 ✔, ttRollExcept 제외값별 100만회 — 중복 0회·나머지 5개 각 20% ✔.

## 2026-07-09 업데이트 4: 재접속 지원 + 인디언 포커

**재접속 (오목/오델로/체스/티카투카)**:
- 연결 끊김(disconnect) 시 즉시 몰수 대신 **60초 유예**: `p.isDisconnected`+`p.graceTimer`, 게임 일시정지(`game_paused` — 기존 오버레이 재활용), 턴 타이머 정지, 채팅 공지. 명시적 나가기(leave_room)는 기존대로 즉시 몰수.
- 몰수 로직은 `forfeitBoardGame(room, roomId, loser)`로 추출 (즉시/유예만료 공용, grace 타이머 일괄 정리, 콜백에 status 가드).
- 복귀: 클라가 connect 시 `rejoin_check {nickname}` → 서버가 playing 방에서 `isDisconnected` 동일 닉 탐색 → socketId 갱신+join+타이머 해제+`game_resumed`+`sendRejoinState`(game_start 개인 재전송 + chess:state/tt:state). 양쪽 다 접속일 때만 isPaused 해제. `resume_game`은 재접속 대기 중 수동 재개 차단.
- 홀덤/블랙잭은 기존 방식 유지 (자동폴드/라운드 제거+환급).

**인디언 포커 (gameType 'indian')** — 홀덤 상태머신 재사용(`room.holdem.indian` 플래그):
- 카드 1장 딜, **베팅 1라운드 후 즉시 쇼다운**(advanceHoldemPhase 인터셉트, runItOut은 1.2초 후 쇼다운), 높은 카드 승리(동점 스플릿), 쇼다운명 "9 카드"/"A 카드".
- **시점 반전**: emitHoldemState 개인화 — 내 카드 null, 상대 카드 공개(폴드 제외). myHandName null. 관전자는 쇼다운 전 전부 비공개(귓속말 치팅 방지). stateBase에 `indian` 플래그.
- 바이인/블라인드/에스컬레이션/올인/사이드팟/버스트 관전 전환/이탈 처리 전부 홀덤 공유. maxPlayers 6. 예측 제외, resign 가드.
- 클라: 홀덤 화면 재사용 — 커뮤니티 영역에 게임 안내 문구, 내 카드 뒷면 1장+"🙈 내 카드: ???", 족보 패널 숨김, 좌석 내 카드 뒷면 1장. 모달 라디오 🂠(바이인 픽커 공유), 배지/대기실(홀덤 그리드 공유).
- 검증: 유예/재접속/만료몰수/즉시몰수 9케이스 + 인디언 딜/시점반전/쇼다운/배당 9케이스 통과. ※python으로 파일 수정 시 CRLF 변환 주의 — `open(newline)` 이슈로 전체 diff 오염됐던 것 LF 복원함.

## 2026-07-09 업데이트 3: 리더보드 + 올인 런아웃 연출

**리더보드**: 로비 `#leaderboard-card` (💰 부자 / ⚫ 오목 pts / 🃏 홀덤 승수, 각 top10). 서버 `get_leaderboard`→`leaderboard` (Record 쿼리 3종, 칭호/닉색 deco 포함). `.lb-tab`(shop-tab CSS 공유, 별도 클래스로 상점 탭과 간섭 없음), 내 행 하이라이트, 메달 🥇🥈🥉. 접속/로비 복귀 시 갱신.

**올인 런아웃 연출**: `runItOut`이 생존 2인 이상이면 — 홀카드 즉시 공개 + `holdemEquity`(몬테카를로 1200회, 리버 1장은 전수) 승률과 함께 `holdem_runout` emit → 스트리트별 1.8초 딜레이로 한 장씩 오픈, 매 스트리트 승률 갱신 → 쇼다운. 클라 `hdRunout`(cards/equity) — 좌석에 공개 카드 + 색상 승률 배지, 새 핸드/쇼다운 시 정리. 에퀴티 검증: AA vs KK 83:17, 리버 확정 100:0, 턴 FD 20%.

**추가 발견·수정한 payload 불일치 버그들** (레이즈 버그와 같은 패밀리):
- `holdem_hand_end`: 서버 `winner/wonAmount` vs 클라 `winnerNickname/pot` → **pot undefined로 핸들러 크래시**, 팟 획득 공지가 아예 안 나오고 있었음
- `holdem_showdown`: 부분 payload({showdownResult,sidePots})를 full state로 renderHoldemTable에 넘겨 **쇼다운 때 좌석이 전멸**하던 버그 → 결과 채팅/상태바 표시로 교체 (전체 상태는 직전 holdem_state가 렌더)
- `holdem_game_over`: `winner` vs `winnerNickname` → 우승자가 undefined로 표시되던 버그 → 수정 + 결과 칩순 정렬

## 2026-07-09 업데이트 2: 홀덤 버그 수정 + 토너먼트화

**버그 수정 (서버 권한 강화)**:
- **레이즈 금액 무시 버그**: 클라 `raiseAmount` vs 서버 `amount` 필드명 불일치로 모든 레이즈가 최소 레이즈였음 → 핸들러가 `raiseAmount || amount || 0` 수신
- **체크 서버 검증**: `p.bet < h.currentBet`이면 check 무시(shift 전 검증, 타이머 유지) — 조작 클라 무료 체크 차단
- **관전자 홀카드 은닉**: 쇼다운 전 관전자에게 null (basePlayers 그대로 전송) — 훔쳐보기 차단
- **프리플랍 족보 오표기**: 홀카드 2장에 5장용 평가 → 수딧이 '플러시' 표시되던 것 → 페어/하이카드만 판정
- **숏 올인 minRaise**: diff >= minRaise일 때만 갱신
- **버스트 관전 전환**: startHoldemHand에서 칩 0 플레이어 제거→spectators 이동 + `holdem_busted` 이벤트 + addHoldemLose (생존 2인 이상일 때만; 최종 패자는 endHoldemGame 처리)

**재미 개선 (판돈이 재산 대비 너무 작던 문제)**:
- 바이인 1천/5천/1만 → **1만/5만/10만/50만** (블라인드 100/200 ~ 5천/1만, HOLDEM_BLINDS 교체, 기본값 전부 10000으로)
- **블라인드 에스컬레이션**: 4핸드마다 2배 (`h.handNumber`, SB 상한 = 바이인/10), 상승 시 📢 채팅 공지. 모달에 "토너먼트 방식" 안내
- 올인 시 📢 채팅 공지, 페이즈 배지에 현재 블라인드 표시

검증: 추출 시뮬 15케이스(레이즈 금액/체크 거부/관전 은닉/프리플랍 족보/에스컬레이션/버스트 전환/올인 공지) 전부 통과.

## 2026-07-09 업데이트: 판돈 50만 + 올인빵

- 판돈 픽커에 **500,000**과 **🔥 올인빵** 추가 (모달 8옵션, 올인빵 선택 시 경고문 표시). `selectedTtBet`은 숫자 또는 'allin' 문자열, dataset 비교는 String으로.
- **올인빵**: `room.ttAllin` — 시작/재대결 시 `ttEscrowBets`가 **각자 전 재산**을 개인별로 차감(`ttEscrowAmounts`), 한쪽이 0코인이면 시작 거부. `ttSettleBets`에서 승자가 합계(`ttLastPot`) 독식, 무승부는 각자 원금 반환(닉네임 키 기준이라 탈주에도 안전). 잔액이 달라도 그대로 전액 (min 매칭 아님).
- 전파: room_list/lobby_state/tt:state에 `ttAllin`/`allin`, game_over 9개 지점에 `ttAllin`/`ttPot` (replace_all). 표시: 방 목록·대기실 '🔥 올인빵', PvP 태그, 결과 오버레이("올인빵 승리! 총 X 획득" / "전 재산 상실").
- 검증: 에스크로/독식/무승부 반환/0코인 거부/중복 정산 방지/기존 50만 경로 11케이스 + 클라 7케이스 + 비올인 회귀 4케이스 통과. ※스크래치패드 정리로 구 스모크 파일 소실 — 재생성 필요 시 CLAUDE.md 명세 참고.

## 2026-07-07 업데이트 3: 준수 돌 스킨 (프리미엄 200만)

- `image/준수백돌.png`(흰 배경+검은 로고)·`준수흑돌.png`(검은 배경+흰 로고)에서 로고를 휘도→알파 변환으로 추출 → `public/image/junsu_w.png`(백돌용 검은 로고)/`junsu_b.png`(흑돌용 흰 로고), 221×396. ※node-canvas는 한글 경로 fopen 실패 → `loadImage(fs.readFileSync(path))` 버퍼 로드로 우회
- 렌더: **클래식 돌 그대로 그린 뒤 로고 스탬프** — drawStoneOnCtx 끝에 junsu 분기(원형 클리핑, 높이 1.3r, globalAlpha 0.92). STONE_COLORS.junsu = classic 복사(폴백/상점 스와치)
- 코드: `JUNSU_IMGS`(goodcoco와 같은 onload 재렌더 패턴), ALL_STYLES/STYLE_NAMES('준수')/PREMIUM_SKINS, 픽커 🔒 슬롯, **SHOP_SKINS junsu: 2000000** (최고가)
- 검증: node-canvas로 오목/오델로 보드 위 흑백 돌 렌더 확인, 문법·스모크 회귀 없음

## 2026-07-07 업데이트 2: 블랙잭 (gameType 'blackjack')

- **룰**: 딜러 = 하우스(서버), 1~5인(솔로 시작 가능 — start_game 2인 체크 예외). 라운드제: 베팅(20초, 프리셋 1천~10만, 즉시 차감) → 딜(2덱) → 히트/스탠드/더블다운(첫 2장, 추가 차감) → 딜러 17까지 히트(전원 버스트 시 드로우 생략) → 정산(승 2배, 블랙잭 2.5배(3:2), 푸시 반환) → 6초 후 다음 라운드. 미베팅 = 그 라운드 관망. 액션 20초 타임아웃 = 스탠드.
- **서버**: `createBjState`/`bjValue`(A=11/1)/`startBjRound`(나간 플레이어 제거+방장 이전, 전원 이탈 시 방 삭제)/`bjDeal`/`bjAdvance`/`bjDealerPlay`/`bjAction`. 이벤트 bj:bet/hit/stand/double, 상태 `bj:state`(betting/acting 중 딜러 홀카드 숨김). handleLeaveRoom 블랙잭 분기(socket.leave + 현재 차례면 자동 스탠드). 예측 베팅 제외, resign 가드(홀덤 포함), maxPlayers 5(4곳), useTimer=false.
- **클라**: `#bj-screen`(딜러 박스/플레이어 박스들/베팅 바/액션 바/채팅), `BJ`/`bj*` 함수, 홀덤 카드 렌더러(`renderHdCard`) 재활용. game_start·spectate_start·bj:state 분기, addChat이 bj 화면 활성 시 `#bj-chat-messages` 라우팅. 대기실은 홀덤식 그리드 공유(5슬롯).
- **검증**: 서버 시뮬 28케이스(밸류 계산/내추럴 자동스탠드/홀카드 숨김·공개/2.5배·2배·푸시 배당/버스트/더블 차감·2배 반영/관망 제외/이탈 제거) + 클라 jsdom 16케이스 전부 통과. 기존 스모크 회귀 없음.

## 2026-07-07 업데이트: 홀덤 이탈/레이아웃 수정

- **로비로 나가면 아웃 처리**: handleLeaveRoom 홀덤 분기에서 `socket.leave(roomId)` 추가 — 이후 holdem_state 브로드캐스트를 안 받아 화면 재소환 버그 해결. `startHoldemHand` 시작 시 `isDisconnected` 플레이어 제거 + **남은 칩 코인 환급**(addCoins) + 방장 이전. `startHoldemTimer`에서 나간 플레이어 차례면 0.4초 후 즉시 자동 폴드(30초 대기 제거).
- **족보 패널 2열 압축**: `.hr-rows` grid 2열, '◀ 현재'→'◀' — 채팅(200px)과 족보가 한 화면에 들어옴.
- 탈주 정산 규칙: 게임 도중 나가면 그 핸드의 베팅분은 팟에 남고(폴드), 남은 스택은 다음 핸드 시작 시 코인으로 환급. 잔여 1명이면 게임 종료 → 승자 정산.

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
