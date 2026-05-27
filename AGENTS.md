# AGENTS.md

## Project Philosophy

- 기존 기능 안정성을 최우선으로 한다.
- 새 기능보다 기존 동작 보존을 우선한다.
- rollback-safe incremental patch 방식으로 수정한다.
- 관련 없는 리팩토링은 금지한다.
- 최소 diff 원칙을 유지한다.
- 문제 해결 시 먼저 원인 분석 후 수정한다.
- 수정 전 어떤 파일을 왜 수정하는지 설명한다.

---

## Critical Existing Behaviors

### Image / Media Handling

- 상위 bullet 이미지 inheritance 로직은 현재 정상 동작 중이며 깨뜨리지 말 것.
- parent block image traversal 로직 유지.
- image embed/import 로직 변경 시 상위 block 이미지 포함 여부 반드시 확인.
- `#+END_EXTRA` 내부 이미지 렌더링 유지.
- image occlusion 관련 HTML 처리 로직은 매우 민감하므로 최소 수정 원칙 적용.
- renderer 단계와 sync 단계의 책임 분리 유지.
- media sync 로직 수정 시 기존 asset path 호환성 유지.

### Deck / Card Ordering

- Logseq block 상하 순서 기반 ordering 유지.
- desiredOrder 관련 로직은 현재 정상 동작 중이므로 신중하게 수정.
- 카드 정렬 수정 시 기존 카드 표시 순서 깨지지 않도록 확인.
- nested block ordering regression 금지.

### Review / History System

- 정답률(history) 삭제 시 review recommendation 계산도 함께 재계산해야 함.
- history 데이터 변경 시 dependent statistics 동기화 유지.
- 기존 review scheduling 데이터 호환성 유지.

### PDF / Annotation

- PDF annotation 기능 기존 동작 유지.
- multiple PDF handling 수정 시 annotation compatibility 유지.
- dark mode 렌더링 깨지지 않도록 주의.

---

## Versioning Rules

- 기능 수정 시 버전 문자열 함께 업데이트.
- title/menu/version text 동기화 유지.
- 버전명은 한글 사용.
- 버전 누락 금지.

---

## TypeScript / React Rules

- React + TypeScript strict 유지.
- 타입 에러를 숨기지 말 것.
- `any` 남용 금지.
- 불필요한 상태(state) 추가 금지.
- 기존 component 구조 최대한 유지.
- 불필요한 hook 리팩토링 금지.

---

## Sync Safety Rules

- sync 로직 수정 시 데이터 유실 가능성 먼저 검토.
- sync 단계 수정 전 parser/renderer 영향도 분석.
- destructive migration 금지.
- 기존 DB/local storage/firebase 구조 호환 유지.

---

## UI / UX Rules

- 기존 UI 흐름 최대한 유지.
- 기능 추가 시 사용자 workflow 깨지 않기.
- 복잡한 설정 UI보다 dropdown / 단계형 선택 우선.
- 기존 dark mode 호환 유지.

---

## Preferred Workflow

1. 먼저 원인 분석
2. 수정 파일 후보 설명
3. 최소 수정 적용
4. 기존 기능 regression 확인
5. 필요한 경우만 추가 리팩토링

---

## Before Large Changes

대규모 수정 전 반드시:

```bash
git commit -m "backup before large patch"