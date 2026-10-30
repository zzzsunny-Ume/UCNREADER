# 배포 가이드

UCN Reader는 정적 파일 5개(`player/` 폴더)로 이루어진 웹 페이지입니다. 서버 코드, 빌드, 데이터베이스, 환경변수가 없습니다.

## 배포 대상

| 파일 | 역할 |
|---|---|
| `player/index.html` | 진입 페이지(마크업·스타일·이벤트 연결) |
| `player/log.js` | 로그 |
| `player/ucn.js` | `.ucn` 해석 |
| `player/player.js` | 재생 엔진 |
| `player/export.js` | 사진/글/로그 저장 |

`index.html`이 나머지 스크립트를 **상대 경로**(`ucn.js` 등)로 불러오므로 다섯 파일을 같은 폴더에 두면 어느 하위 경로(`/ucnreader/` 등)에서도 동작합니다.
`docs/`, `tools/`, `README.md`는 배포하지 않습니다.

## 현재 저장소 상태

- 배포 브랜치: `main`
- 배포 설정: `.github/workflows/pages.yml` — `main`에서 `player/**` 또는 이 파일이 바뀌면 실행, Actions 탭에서 수동 실행도 가능
- 문의 연락처: jisun645028@gmail.com (README, 첫 화면 하단에 표시)

### 처음 한 번만 할 일 (저장소 설정)
1. **Settings → General → Default branch**를 `main`으로 바꿉니다.
2. **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿉니다.
3. 배포 설정이 들어간 PR을 `main`에 병합하면 첫 배포가 실행됩니다. 이미 병합했다면 **Actions → Deploy player to GitHub Pages → Run workflow**로 실행합니다.
4. 배포가 끝나면 Settings → Pages 상단에 주소가 표시됩니다(보통 `https://<계정>.github.io/<저장소 이름>/`).

## GitHub Pages로 배포 (권장: GitHub Actions)

GitHub Pages의 "브랜치에서 배포" 방식은 저장소 루트(`/`)나 `/docs`만 게시할 수 있습니다.
이 저장소는 `docs/`에 문서가 있으므로, **`player/` 폴더만 올리는 Actions 방식**을 권장합니다.

1. 아래 내용이 `.github/workflows/pages.yml`에 들어 있습니다(이미 추가됨).

   ```yaml
   name: Deploy player to GitHub Pages
   on:
     push:
       branches: [main]
       paths: ['player/**', '.github/workflows/pages.yml']
     workflow_dispatch:
   permissions:
     contents: read
     pages: write
     id-token: write
   concurrency:
     group: pages
     cancel-in-progress: true
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - uses: actions/checkout@v4
         - uses: actions/configure-pages@v5
         - uses: actions/upload-pages-artifact@v3
           with:
             path: player
         - id: deployment
           uses: actions/deploy-pages@v4
   ```

2. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿉니다.
3. 기본 브랜치에 푸시하면(또는 Actions 탭에서 수동 실행) 배포됩니다.
4. 주소는 보통 `https://<계정>.github.io/<저장소 이름>/` 입니다. Settings → Pages에 실제 주소가 표시됩니다.

### 대안
- **루트 게시**: `player/`의 다섯 파일을 저장소 루트로 옮기고 Pages Source를 "Deploy from a branch → `/ (root)`"로 지정. 이 경우 `README.md`, `docs/`도 함께 공개 URL로 접근 가능해집니다.
- **다른 정적 호스팅**(Netlify, Cloudflare Pages, Vercel 등): 게시 폴더를 `player`로, 빌드 명령은 비워 둡니다.

## 배포 전 점검표

### 기능
- [ ] 첫 화면: 파일 선택 버튼, 화면 전체 끌어다 놓기, 휴대폰 세로 레이아웃
- [ ] 정상 파일: "클릭해서 시작" → 1~16장 자동 넘김 → 17장부터 클릭 진행
- [ ] 텍스트: 줄바꿈/`#p`에서 멈춤, `#w;`에서 멈춤 후 같은 줄 이어서 출력, 출력 중 클릭 시 즉시 완성
- [ ] `←` 이전 장, 끝 화면 `처음부터`, `다른 파일 열기`
- [ ] 오른쪽 아래 `▶ 곡명.mp3` 표시가 장 구간에 맞게 바뀜
- [ ] 사진 전부 받기: zip이 열리고 한글 파일명이 깨지지 않음
- [ ] 글 전부 저장: 메모장·한글 등에서 한글이 깨지지 않음(UTF-8 BOM 포함)
- [ ] Log 보기: 오류 배지, 복사, 로그 저장, `Esc`로 닫기
- [ ] 깨진 파일(잘린 파일·아무 파일): 첫 화면에 오류 상자 + Log 링크, 페이지가 멈추지 않음

### 브라우저
- [ ] 데스크톱 Chrome / Edge / Firefox / Safari 최신
- [ ] iOS Safari 16.4 이상, 안드로이드 Chrome / 삼성 인터넷
- [ ] 큰 파일(25MB 이상)에서 휴대폰 메모리 부족 여부

### 배포 환경
- [ ] HTTPS로 제공(클립보드 복사 기능은 HTTPS 또는 localhost에서만 동작)
- [ ] 하위 경로(`/<저장소 이름>/`)에서 스크립트 5개가 모두 로드됨(브라우저 개발자 도구 Network 탭)
- [ ] Google Fonts 차단 환경에서도 기본 글꼴로 정상 표시
- [ ] 콘솔 오류 없음

### 문서·안내
- [ ] README의 "지원 범위와 한계"가 현재 동작과 일치
- [ ] 문의 메일(jisun645028@gmail.com) 링크가 README와 첫 화면에서 열림
- [ ] 비공식 도구 안내 문구 유지

## 업데이트·캐시

- 파일 이름에 버전이 없으므로, 업데이트 직후 이용자 브라우저에 이전 스크립트가 남아 있을 수 있습니다.
  문제가 되면 `index.html`의 스크립트 태그에 쿼리를 붙여 갱신합니다(예: `ucn.js?v=2`).
- GitHub Pages는 기본 캐시가 짧아(약 10분) 보통 별도 조치가 필요 없습니다.

## 되돌리기

GitHub Actions 방식이면 이전 커밋으로 되돌린 뒤 푸시하거나, Actions 탭에서 이전 실행의 **Re-run**으로 이전 버전을 다시 배포합니다.
