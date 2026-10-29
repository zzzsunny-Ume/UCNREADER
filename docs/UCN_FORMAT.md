# .ucn 파일 포맷 (역공학 노트)

샘플 1개(`de46dac1-1.ucn`, 25.4MB, 2019년 8월 작성)를 분석해 정리한 내용입니다.
추출기: [`tools/ucn_extract.py`](../tools/ucn_extract.py)

## 1. 컨테이너

ZIP을 살짝 변형한 구조입니다.

| 오프셋 | 내용 |
|---|---|
| `0x00` (16바이트) | 자체 헤더 `02 00 00 00 00 00 00 00 00 00 00 00 06 00 00 00` (의미 미확인, 버전으로 추정) |
| `0x10` | 첫 엔트리 로컬 헤더. 시그니처가 `PK\x03\x04`가 아니라 **`UC\x03\x04`** |
| 이후 | 나머지 엔트리는 일반 `PK\x03\x04`, 끝에 `PK\x01\x02` 중앙 디렉터리, `PK\x05\x06` 종료 레코드 |

- 압축 방식 필드는 `0`(stored)이지만, 저장된 바이트는 **zlib 스트림**(`78 DA`)입니다.
  CRC32는 zlib 스트림(압축된 바이트) 기준입니다. → 일반 unzip 후 `zlib.decompress` 한 번 더.
- **파일명**은 hex 문자열로 저장됩니다(`7363726970742e786d6c` → `script.xml`).
  hex를 풀어낸 바이트는 독자 인코딩입니다:
  - `< 0x80`: ASCII 1바이트
  - `0xFF hi lo`: 코드포인트 `hi lo` (상위 바이트가 0x80 미만인 문자, 예: `ㄱ` U+3131 → `FF 31 31`)
  - 그 외 `hi lo`: 코드포인트 2바이트 빅엔디언 (예: `셋` U+C14B → `C1 4B`)
- 첫 엔트리가 `script.xml`, 나머지는 이미지(png/jpg). **음원(mp3)은 들어있지 않고** 서버 경로만 참조합니다.

## 2. script.xml

```
<ucscript owner="...">
  <global>
    <system>   폰트, 기본 글자크기, 화면 크기(800x480)
    <resource> <folder><object id type="image|back|bgm" itemId><file name/></object>...
    <scenario> <node id="59">대사 텍스트</node>...   ← 텍스트 원문 풀
    <script>   (비어 있음, ";;")
  </global>
  <content>
    <scene id="시작장면" page="210">     ← 전체 장 수
      <folder type="fixed">
        <layer type="scenario"> <node ref="텍스트id" page="N" x y width height color align ...>
        <layer type="back">     <node ref="배경id" start="N" end="M" x y width height z> <effect .../>
        <layer type="bgm">      <node ref="음악id" start="N" end="M" volume repeat="loop" fadein fadeOut>
        <layer type="effect"/>  <layer type="group"/>
      </folder>
      <folder type="layer"> <layer type="image" ref=...> <node ref start end x y width height z> <effect/>
      ...
      <delay page="N" mode="" time="ms"/>     ← N장: time(ms) 후 자동 넘김
      <delay page="N" mode="scen" time="0"/>  ← N장: 텍스트 클릭 대기
    </scene>
  </content>
</ucscript>
```

### 장(page) 규칙
- 텍스트(`scenario`)는 `page` 한 장에만 나옵니다. `ref`는 `<global><scenario>`의 텍스트 id.
- 배경/이미지/BGM은 `start ≤ 현재장 ≤ end` 구간 동안 유지됩니다.
- 이미지 겹침 순서는 `z` 오름차순(작을수록 아래), 같으면 문서 순서.
- `<effect type="start|end" effect="fade|vortex|none" time="ms">` 등장/퇴장 효과.
- 넘김: `delay mode=""` → 자동(time ms), `mode="scen"` 또는 delay 없음 → 클릭.

### 텍스트 마크업
| 토큰 | 의미 |
|---|---|
| 줄바꿈 | 그대로 줄바꿈 |
| `#p` | 문단 구분 — 클릭하면 다음 문단을 이어서 표시 |
| `#w;` | 잠깐 멈춤(타이핑 도중 짧은 정지) |

### 음원
`<object type="bgm" itemId="70164"><file name="2019/08/21/f3k28agijf38002035.mp3"/>` 처럼
원래 서비스 서버의 상대경로만 있습니다. 재생하려면 같은 음원을 따로 구해 경로/이름을 맞춰야 합니다.
