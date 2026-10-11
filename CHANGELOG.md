# CHANGELOG — 쓰자고

> 2026-10-11에 프로젝트 배포로드맵과 저장소 기록을 바탕으로 다시 작성한 문서입니다. 원본 v1.0.1~v1.0.3 CHANGELOG는 업로드 때 빠졌습니다. 그래서 버전별 세부 기록(원인·범위·검증 결과)은 원본 파일을 받으면 보완합니다.

## 1.0.4 — AI 사진 인식 연결 (2026-10-11, 2단계)
- 새 파일 `ai-recognize.js`: `recognizeProducts(file)` 어댑터. 앱 화면은 공급자(Gemini)를 모르고 표준 결과만 받습니다.
  - 전송 전 긴 변 1024px JPEG로 다시 그려 EXIF(위치 등)를 제거합니다.
  - 기기 구분용 무작위 ID(`sj-device-id`)를 처음 한 번 만들어 저장합니다. 개인정보는 포함하지 않습니다.
- `photo-import.html`
  - AI 인식이 기본이고, 실패하면 기기 내 문자 인식(tesseract)으로 대신합니다. tesseract는 필요할 때만 불러옵니다.
  - 결과 카드에 브랜드 칸과 신뢰도 낮음 '확인 필요' 표시를 추가했습니다. 저장 전에 '○개 등록할까요?' 확인을 받습니다(자동 저장 없음).
  - '오늘 남은 AI 인식 N회'를 표시합니다. 한도나 월 상한에 도달하면 안내하고 '직접입력으로 등록하기' 버튼을 보여줍니다.
  - 등록 시 브랜드(brand) 필드도 함께 저장합니다(기존 필드는 변경 없음).
  - AI 전송 고지 문구를 추가했습니다(전송 목적, 처리업체 Google, 서버 미저장).
- `config.js`: appVersion 1.0.4, ai.endpoint = Worker 주소(비밀값 아님)
- `sw.js`: 캐시 sseujago-v34, ai-recognize.js 추가. 다른 주소(Worker) 응답은 캐시하지 않습니다.
- 새 폴더 `worker/worker.js`: Cloudflare Worker 원본 보관용입니다(배포는 Cloudflare 대시보드에서). 키 없음.
- 검증(375px, Playwright, AI 서버 모의): 인식 성공 2장 → 같은 제품 수량 합산, 3번째 요청 한도 초과 → 기기 내 인식 전환·직접입력 버튼 표시, 제품명에 HTML이 들어와도 화면에서 실행되지 않음, 등록 확인 후 저장, 전체 5개 화면 스크립트 오류 0건
- 제한: 실제 Gemini 인식 정확도는 링크(Cloudflare Pages) 연결 후 본인 사진으로 확인 예정

## 1.0.3 — 저장소 정리 (2026-10-11)
- 미사용 파일 6개를 삭제했습니다: `app-ui-v2.js`, `design-system.js`(옛 민트색 #BEE506 포함), `main-fixes.js`, `safety-features.js`, `ui-common.js`, `icon.svg`
  - 확인: 모든 HTML 파일과 `sw.js` 캐시 목록 어디에서도 참조하지 않으므로 앱 동작에 영향이 없습니다.
- 서비스워커 캐시: sseujago-v33 (변경 없음)

## 1.0.1 ~ 1.0.3 — 1단계 준비 (요약)
- `config.js`를 추가했습니다: target(web/play), adsEnabled, appVersion, dataVersion. 링크용(web)에서는 광고가 꺼진 상태로 고정됩니다.
- 사진을 긴 변 640px JPEG로 압축합니다. 이로써 저장 실패 버그를 수정했습니다.
- 저장공간이 초과되면 안내합니다.
- 복원 전에 확인을 받고 파일을 검증합니다. 백업은 version 2 형식(app·version·appVersion·exportedAt·items·locations)입니다.
- `?add=1` 버그를 수정했습니다.
- 홈 아이콘: #5B4885 배경에 흰색 '쓰자고' 글자를 최대 크기로 넣었습니다. 180·192·48 크기와 maskable 192·512 크기를 함께 만들었습니다.
- 실행화면 배경(manifest background_color)을 #C8C2ED로 되돌렸습니다.
