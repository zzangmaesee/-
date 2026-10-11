# CHANGELOG — 쓰자고

> 2026-10-11에 프로젝트 배포로드맵과 저장소 기록을 바탕으로 다시 작성한 문서입니다. 원본 v1.0.1~v1.0.3 CHANGELOG는 업로드 때 빠졌습니다. 그래서 버전별 세부 기록(원인·범위·검증 결과)은 원본 파일을 받으면 보완합니다.

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
