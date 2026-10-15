> model: openai/gpt-6.1-sol · fresh-round design · finish=stop · 50s · usage={'prompt_tokens': 452, 'completion_tokens': 2056, 'total_tokens': 2508, 'prompt_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0, 'audio_tokens': 0, 'image_tokens': 0}, 'completion_tokens_details': {'reasoning_tokens': 70, 'audio_tokens': 0, 'accepted_prediction_tokens': 0, 'rejected_prediction_tokens': 0}}

## A) 리스크

제공된 브리프 기준이며, 코드·Pollinations API 현행 계약은 확인하지 않았습니다.

| 리스크 | 영향 / 최소 대응 |
|---|---|
| API 계약 미확인 | 인증 방식, 4개 모델의 지원 ID, browser CORS, 과금·rate limit을 확인해야 함. **정적 SPA에서 직접 호출할 수 없으면 현재 설계로는 출시 불가** |
| 모델 정답의 신뢰성 | 요청한 모델과 실제 생성 모델이 달라지면 추리 게임이 성립하지 않음. 자동 model routing/fallback 여부 확인 |
| 키 노출 | `sessionStorage`도 같은 origin의 JavaScript에서 읽을 수 있음. XSS 방어 및 로그·URL·공유 결과에서 키 제외 필요 |
| 비용·지연 | 라운드당 4회, 5라운드 성공 시 기본 20회 요청. 일부 실패도 이미 발생한 비용을 되돌리지 못할 수 있음 |
| 기존 모드 오염 | Fresh의 키·네트워크 의존성을 Daily/Practice에 섞으면 회귀 위험. 생성 경로를 분리 |

## B) 질문별 답변

### 1. 최소 설계·`bank.js` 추상화

- 기존 Daily/Practice 옆에 **Fresh — 실시간 생성** 버튼 추가.
- 흐름: **모드 선택 → 키 입력·비용 동의 → 시작 → 현재 라운드의 4모델 생성 → 기존 라운드 UI·채점**.
- 시작 시 5라운드를 모두 생성하지 말 것. **라운드별 on-demand**로 호출해 중도 이탈 비용을 줄임.
- 생성 중에는 Guess/Next를 잠그고 진행 상태만 표시. 응답 도착 순서가 아니라 기존 shuffle 방식으로 배치.
- Fresh prompt는 기존 bank에 있는 질문을 재사용해도 됨. **답변만 실시간 생성**한다는 의미를 명시.

추상화는 기존 전체를 재작성하지 않는 수준으로:

```js
roundSource.getRound({ roundIndex, signal })
// → 기존 game.js가 받는 round 형식
```

- `bank.js`: 기존 정적 데이터 로딩·검증 유지.
- `fresh.js`: API 호출과 응답 정규화 담당.
- `main.js`: 모드별 source 선택.
- `game.js`: 키·endpoint를 모르고 완성된 round만 받음.

**4개 유효 응답이 모두 확보되기 전에는 round를 game state에 넣지 않는 atomic commit**을 권장합니다. 정확한 필드 이름은 실제 round schema에 맞춰야 합니다.

### 2. 키 취급 계약

**입력**
- `type="password"` 사용. Show/Hide 및 “키 삭제” 제공.
- URL query, hash, HTML 속성, global variable에 키를 넣지 않음.
- 형식 검사는 빈 값 정도만 확인. 인증 성공을 로컬 검사로 가장하지 않음.

**보관**
- 전용 `sessionStorage` 항목 하나만 사용.
- `localStorage`, IndexedDB, cookie, service worker cache에는 저장 금지.
- storage가 차단되면 in-memory만 사용하고 안내.
- Fresh 종료·다른 모드 전환·“키 삭제” 시 저장값과 input/state의 참조 제거.
- 탭 종료 시 storage 폐기는 브라우저 정책에 따름. JavaScript 메모리의 완전한 secure erase는 보장하지 않음.

**전송**
- 검증된 **HTTPS gen endpoint allowlist**에만 전송.
- 공식 API가 지원하는 인증 header 사용. URL에 키를 넣지 않음.
- `credentials: "omit"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"` 사용.
- redirect는 거부해 예상 밖 목적지 전송을 방지.
- 키를 지원하지 않는 제3자 proxy로 우회하지 않음.

**테스트로 고정**
- 키가 허용 endpoint의 요청에만 포함됨.
- URL·로그·오류 UI·share payload·영속 storage에는 없음.
- 삭제/모드 전환 후 후속 요청이 없음.
- Daily/Practice는 키 없이 실행되고 gen API 호출도 없음.

추가로 모델 출력은 **`textContent`로 렌더링**하고 `innerHTML`로 삽입하지 않습니다.

### 3. 실패 처리

**기본 정책: 정적 bank로 silent fallback하지 않고, 현재 라운드를 중단·미채점 상태로 유지.**

| 실패 | 처리 |
|---|---|
| `401` | 모든 진행 요청 취소, 키 삭제, 재입력 안내. 자동 재시도 없음 |
| `429` | 자동 재시도 없음. `Retry-After`가 읽히면 재시도 가능 시점 표시 |
| timeout/network/`5xx` | 요청 취소·현재 라운드 미채점. 명시적 Retry/Exit 제공 |
| 일부 모델 실패 | 성공 응답은 메모리에 유지하고 **실패한 모델만** 사용자 동의 후 재시도 |
| 빈 응답·잘못된 schema·모델 불일치 | 해당 모델 실패로 처리 |
| Exit/모드 전환 | 진행 요청 abort, 늦게 도착한 결과 무시 |

- 이미 성공한 모델을 재생성하면 추가 비용이므로 기본 동작으로 삼지 않습니다.
- 실패 라운드를 skip하면 “5라운드 점수” 의미가 바뀌므로 최소 버전에서는 제외합니다.
- 서버가 이미 생성 중이면 `abort`해도 과금은 발생할 수 있다고 안내합니다.
- Fresh 결과는 Daily streak/공유 결과와 구분합니다.

### 4. 비용 고지·사용량

키 입력 화면의 Start 버튼 바로 위에 명시:

> Fresh는 입력한 키로 Pollinations API를 직접 호출합니다. API 사용료는 플레이어 부담이며, 계정·모델 정책에 따라 발생할 수 있습니다. 기본 요청은 라운드당 4회, 5라운드 총 20회입니다. 실패·재시도·취소된 요청도 비용이 발생할 수 있습니다. Daily와 Practice는 키 없이 사용할 수 있습니다.

- 시작 전에 별도 동의 checkbox 권장.
- 플레이 중 **이번 게임 요청 수 / 성공 / 실패**를 표시. 재시도도 요청 수에 포함.
- API가 신뢰할 수 있는 usage를 반환하면 token usage 추가 가능.
- **요청 수를 실제 청구액으로 표시하지 말 것.** 금액 추정·계정 잔액 조회는 최소 버전 비목표.

### 5. 최소 테스트·비목표

무의존 테스트를 유지하고, `fetch`·storage·timer를 주입해 network 없이 검증합니다.

**최소 케이스**
1. 4개 응답 성공 → 기존 round schema로 정규화·한 번만 commit.
2. 응답 순서가 달라도 answer–model 정답 매핑 유지.
3. 키 전송 allowlist·header 검증 및 영속 저장/공유 유출 방지.
4. `401` → 키 삭제·추가 요청 없음.
5. `429`/timeout/network failure → 자동 재시도 없음·미채점 유지.
6. 부분 실패 → 성공 응답 유지·실패 모델만 재시도.
7. Exit/모드 전환 → abort 및 stale response 무시.
8. API 출력의 HTML이 실행되지 않음.
9. Daily UTC determinism·Practice·5라운드 채점·share 회귀.
10. Daily/Practice 실행 시 gen API 호출이 0회.

기존 `npm run check`에 추가하고, 별도로 **실키 browser smoke test**를 수행합니다. mock 테스트만으로 CORS·실제 모델 ID·과금 계약을 입증할 수는 없습니다.

**비목표**
- Backend/proxy 도입, 키 영속 보관
- 자동 재시도·자동 모델 대체·정적 답변 silent fallback
- 전 라운드 선생성, 탭 간 공유 cache
- 정확한 청구액 계산
- 기존 game engine 전면 개편

## C) 판정: **조건부 가**

정적 SPA와 기존 게임 로직을 유지한 구현은 타당합니다. 다만 **browser 직접 인증 호출 가능성과 실제 모델 식별 보장**이 출시 선행조건입니다.

### 실행 체크리스트

- [ ] 공식 API 계약 확인: endpoint, 인증 header, CORS, 4개 model ID, routing/fallback, 과금
- [ ] `roundSource` 경계 및 Fresh 전용 adapter 추가
- [ ] 키 lifecycle·endpoint allowlist·비용 동의 구현
- [ ] 라운드별 4요청, atomic commit, timeout/abort 구현
- [ ] 부분 실패 재시도·stale response 차단 구현
- [ ] Fresh 점수·share를 Daily와 구분
- [ ] 최소 테스트 및 기존 `npm run check` 통과
- [ ] 실키 browser smoke test 후 키·로그·storage 유출 점검