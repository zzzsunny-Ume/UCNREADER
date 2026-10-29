# UCN Reader

사라진 `.ucn` 비주얼노벨 파일을 브라우저에서 다시 재생하는 플레이어.

## 플레이어
`player/index.html`을 브라우저로 열고 `.ucn` 파일을 끌어다 놓으면 됩니다(서버 불필요, 파일은 브라우저 밖으로 나가지 않음).

- 클릭 · Space · Enter · → : 다음 (타이핑 중이면 즉시 완성, 줄바꿈·`#p`·`#w;`에서 멈춘 상태면 이어서 출력)
- ← : 이전 장
- 자동 넘김 장(오프닝 등)은 파일에 적힌 시간대로 넘어갑니다.
- 음원은 파일에 없으므로 진행 중인 BGM 이름만 화면 오른쪽 아래에 `▶ 제목.mp3`로 작게 표시합니다.

## 도구
- `tools/ucn_extract.py INPUT.ucn OUTDIR` — 이미지·script.xml 추출 + 장별 타임라인 `story.json`
- 포맷 설명: [`docs/UCN_FORMAT.md`](docs/UCN_FORMAT.md)
