# .ucn 파일 포맷 (역공학 노트)

샘플 1개(`de46dac1-1.ucn`, 25.4MB, 2019년 8월 작성)를 분석해 정리한 내용입니다.
추출기: [`tools/ucn_extract.py`](../tools/ucn_extract.py) · 웹 플레이어 동작: [`PLAYER.md`](PLAYER.md)

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
- 중앙 디렉터리/종료 레코드의 오프셋은 16바이트 머리말을 **뺀** 위치 기준입니다
  (일반 ZIP을 만든 뒤 앞에 16바이트를 붙이고 첫 `PK`를 `UC`로 바꾼 형태).
- 바이트 전수 확인: 머리말 + 84 엔트리 + 중앙 디렉터리 + 종료 레코드로 파일 전체가 빈틈없이 설명됨.
  zlib 스트림 뒤 꼬리 데이터, 이미지 끝(IEND/EOI) 뒤 덧붙은 데이터, ZIP 주석/extra 필드 모두 없음.

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
- `<effect type="start|end" effect="…" time="ms" x y width height rotation option>` 등장/퇴장 효과. 효과 이름 22종과 마스크 동작은 [`PLAYER.md`](PLAYER.md) 참고.
- 넘김: `delay mode=""` → 자동(time ms), `mode="scen"` 또는 delay 없음 → 클릭, `mode="button"` → 입력창 제출 대기.
- 텍스트 노드의 `background`·`opacity`(0~100)·`border`·`bordercolor`·`radius`는 글창(텍스트 상자 배경) 모양, `speed`는 글자 속도(0 = 독자 설정), `event`는 넘김 방식.
- `advtype="input"` 이미지 리소스는 이름 입력창 컴포넌트. 입력 처리는 `<global><script>`의 `onInput[노드ID]` 함수([`PLAYER.md`](PLAYER.md) "이름 입력창").

### 텍스트 마크업
원본 플레이어 코드(`UCScenario`, `UCActionTag.convertTag`)에서 확인한 규칙입니다.

| 표기 | 동작 |
|---|---|
| 줄바꿈, `#p` | 줄을 끝내고 **클릭 대기** (`#p`는 출력 전에 `\r`로 바뀜). 빈 줄은 대기 없음 |
| `#w;` | 같은 줄에서 **클릭 대기** 후 이어서 출력 |
| `#c;` | 다음 줄바꿈에서 대기하지 않고 이어감 |
| `#d.N;` | N초 멈춘 뒤 자동으로 이어감 |
| `#g.…;`, 그 밖의 `#이름;` | 작품 스크립트(UCscript) 함수 호출 |
| `$변수;`, `$배열[i];` | 작품 스크립트 전역 변수 값 출력(없으면 빈 문자열). 배열은 `,`로 나눈 i번째 |

- `$` 또는 `#` 뒤 첫 `;`까지가 태그. `;`가 없으면 문자 그대로 출력(예: `# 우주의 연하`).
- 이름 입력은 플레이어 기능이 아니라 작품마다 `input` 컴포넌트 + 스크립트(`onInput`)로 변수에 넣는 방식.
  그래서 `$성;`, `$이름;` 같은 변수 이름도 작가마다 다름.
- 타이핑 속도: 글자당 `(50 - scenSpeed/2)` ms. 노드 `speed=0`이면 독자 설정값(기본 70 → 15ms), 100이면 즉시.
- 넘김 방식: 노드 `event`가 `para`/`page`/`auto`, 비어 있으면 독자 설정(기본 `para` = 클릭).
  auto일 때 줄 대기 `paraDelay×100`ms(기본 2초), 장 대기 `pageDelay×100`ms(기본 3초).
- 글이 텍스트 상자 줄 수를 넘으면 상자를 비우고 이어서 출력.

### 음원
`<object type="bgm" itemId="70164"><file name="2019/08/21/f3k28agijf38002035.mp3"/>` 처럼
원래 서비스 서버의 상대경로만 있습니다. 플레이어 코드상 실제 주소는
`http://kr.my.ucnovel.com/storage/music/` + 경로입니다(서비스 종료로 현재 접속 불가). 재생하려면 같은 음원을 따로 구해 경로/이름을 맞춰야 합니다.

## 원본 플레이어
유씨노벨 안드로이드 플레이어 1.0.6(`air.com.ucnovel.player`, Adobe AIR)의 `assets/UCMobilePlayer4.swf`를
역어셈블해 위 규칙을 확인했습니다. 작품 스크립트 라이브러리 함수는 74개
(`gotoPage`, `showNode`, `playSound`, `setData`, `menu`, `alert` 등)이며, 이 저장소의 웹 플레이어는 아직 스크립트를 실행하지 않습니다.
