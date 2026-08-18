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

대규모 수정 전에는 현재 작업 트리와 원격 기준점을 먼저 기록한다. 사용자 변경이 있는 작업 트리를 임의로 커밋하거나 덮어쓰지 않는다.

```text
git status --short --branch
git remote -v
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
```

---

## Cross-Platform Environment Rules

- Windows와 macOS를 모두 지원한다. 운영체제별 기본 절대 경로를 코드, 설정 기본값, 문서 규칙에 하드코딩하지 않는다.
- 저장소 루트는 `git rev-parse --show-toplevel`로 찾는다. 현재 폴더가 Git 저장소가 아니면 부모/형제의 실제 후보를 조사한 뒤 remote URL과 브랜치로 식별한다.
- 경로는 플랫폼 API(`path.join`, URL API 등)로 조합하고 `/Users/...`, `C:\\Users\\...`, 바탕 화면 위치를 가정하지 않는다.
- macOS는 공백·한글·Unicode 정규화·대소문자 차이를, Windows는 역슬래시·드라이브 문자·경로 인용을 검증한다.
- 셸 전용 문법을 공용 스크립트에 넣지 않는다. Node 기반 스크립트를 우선하고, OS별 명령이 필요하면 명시적으로 분기한다.
- Logseq graph와 MK 저장소 경로는 사용자가 선택하거나 런타임 API에서 얻는다. 기본값은 비워 두며 기존 사용자 설정은 유지한다.

## Git Source-of-Truth Rules

- MK의 정본은 GitHub `origin/main`이다. 작업 전 반드시 fetch하고 local HEAD, origin/main, ahead/behind, working tree를 확인한다.
- 로컬이 behind이고 사용자 변경 또는 로컬 전용 커밋이 없을 때만 fast-forward한다. diverged, dirty, remote 불일치 상태에서는 원인을 확인하기 전 수정·push·배포하지 않는다.
- `git reset --hard`, 강제 push, 사용자 파일 삭제, 확인되지 않은 덮어쓰기를 금지한다.
- 커밋 후 `git push origin main`, `git ls-remote origin refs/heads/main`, 로컬/원격 SHA 일치를 확인한다.

## User-Data Safety Rules

- Firebase, localStorage, 학습 이력, 통계, 즐겨찾기, PDF 원문/주석을 사용자 데이터로 취급한다.
- 복원은 먼저 기존 값을 보존한 상태에서 새 값을 검증하고 원자적으로 교체한다. 쓰기 실패를 이유로 현재 정상 값을 먼저 삭제하지 않는다.
- quota 대응으로 삭제할 수 있는 것은 재생성 가능한 캐시뿐이다. 학습 통계·진행률·사용자 설정·백업 원본은 삭제하지 않는다.
- checksum은 Firebase가 빈 배열을 생략하거나 숫자 키 객체로 직렬화하는 경우와 객체 키 순서를 정규화한 뒤 비교한다.
- 복구 전 원본 백업 ID, 시각, 개수, checksum을 기록하고 저장소 밖에 원본 사본을 보존한다. 복구본은 새 backup ID로 추가하며 기존 백업을 수정하지 않는다.
- 초기 cloud hydration이 끝나기 전 학습 통계 쓰기를 차단한다. 복원 실패 후 빈 통계를 생성하여 정상 데이터 위에 쓰지 않는다.

## PDF Annotation Publication Rules

- MK 동기화는 deck TXT와 `pdf-annotations.json`을 같은 publish lifecycle에서 생성·검증·커밋·push한다.
- 카드 캐시 schema 또는 `data-source-uuid` 생성 규칙이 바뀌면 render cache version을 올린다.
- text/area annotation, block reference, 직접 UUID, 한글·공백·특수문자 PDF 파일명, iOS/macOS URL 처리를 회귀 테스트한다.
- 주석 페이지에서 만든 새 카드가 누락되면 deck만 고치지 말고 Logseq source → 렌더링 metadata → published index → MK lookup → viewer URL 전체 경로를 확인한다.

## Test, Deploy, and Live Verification

- 변경 범위의 단위/회귀 테스트를 먼저 실행하고, 가능하면 전체 테스트를 실행한다. 실패를 숨기거나 관련 없는 실패로 단정하지 않는다.
- 학습 통계는 `기존값 X → 복원 후 X → 리뷰 1회 X+1 → reload X+1 → sync X+1` 생명주기를 검증한다.
- PDF는 기존 카드와 새 카드 모두 아이콘 노출, 클릭, 정확한 PDF/page/annotation UUID 전달을 검증한다.
- push가 끝났다고 배포 완료로 간주하지 않는다. GitHub Pages/PWA의 실제 응답에서 새 버전과 산출물 내용을 확인한다.
- 서비스 워커 캐시가 있으면 새 버전 배포 후 fresh profile 또는 cache-busting 요청으로 live asset을 검증한다.
- 완료 보고에는 수정 저장소/브랜치/SHA, 테스트 결과, 배포 URL, 복구 backup ID와 보존한 원본 ID를 포함한다.
