# Contributing to LogDock

LogDock은 여러 서비스와 서버의 로그를 다루는 self-hosted 도구를 목표로 합니다. 현재 구현 범위는 README와 구성 문서에서 확인할 수 있습니다.

## 로컬 개발

1. `.node-version`에 지정된 Node.js와 npm 11.x를 준비합니다. fnm을 사용한다면 저장소 루트에서 `fnm use`를 실행합니다.
2. `npm ci`로 의존성을 설치합니다.
3. 별도 터미널에서 `npm run dev:api`와 `npm run dev:web`을 실행합니다.
4. 변경 후 `npm run typecheck`와 `npm run build`를 확인합니다.

## 변경 제안

- 변경의 목적, 영향을 받는 동작, 확인한 방법을 PR에 설명해 주세요.
- 서비스명·서버 수·클라우드 공급자를 코드에 고정하지 않습니다. 조직별 값은 배포 설정으로 주입합니다.
- 실제 운영 로그, 내부 주소, 토큰, 인증서 개인 키와 개인 식별값은 커밋하지 않습니다. 예시는 합성 데이터로 작성합니다.
- 문서에서는 현재 구현된 동작과 계획을 구분해 주세요.

## 라이선스

프로젝트 라이선스는 [Apache License 2.0](LICENSE)입니다. 기여에는 해당 라이선스의 contribution 조항이 적용됩니다.
