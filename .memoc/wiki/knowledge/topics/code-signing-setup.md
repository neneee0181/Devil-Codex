---
memoc: true
type: wiki
scope: project-memory
created: 2026-06-25T00:00:00
updated: 2026-06-25T00:00:00
status: active
confidence: high
tags:
  - memoc
  - memoc/wiki
  - memoc/knowledge-wiki
  - memoc/topic
  - m4
  - signing
---
# Code Signing & Notarization Setup (M4-A3)

코드는 준비됨. 인증서/secret만 넣으면 서명+notarize+자동업뎃 작동.
참고: [[m4-implementation-plan]].

## 현재 상태

- `build/entitlements.mac.plist`: hardened runtime entitlements (Electron + node-pty + 번들 codex용).
- `package.json` mac: `hardenedRuntime:true`, `entitlements`, `notarize:false`(기본).
- `.github/workflows/release.yml`: secret 있으면 서명+notarize, 없으면 미서명. v* 태그면 GitHub Release publish.
- secret 없으면 지금도 미서명 빌드 정상 (mac 자동업뎃만 불가).

## macOS (Apple Developer 계정 $99/년 필요)

필요 GitHub secret:
```text
MAC_CSC_LINK                 # Developer ID Application .p12 → base64
MAC_CSC_KEY_PASSWORD         # .p12 export 비밀번호
APPLE_ID                     # Apple 계정 이메일
APPLE_APP_SPECIFIC_PASSWORD  # appleid.apple.com → 앱 암호 생성
APPLE_TEAM_ID                # developer.apple.com membership → Team ID
```

발급 순서:
1. developer.apple.com 가입 ($99/년).
2. Xcode 또는 developer 포털에서 **Developer ID Application** 인증서 발급.
3. Keychain Access → 인증서+개인키 → `.p12`로 내보내기 (암호 지정).
4. `base64 -i cert.p12 | pbcopy` → `MAC_CSC_LINK` secret에 붙여넣기.
5. appleid.apple.com → 로그인 및 보안 → 앱 암호 → `APPLE_APP_SPECIFIC_PASSWORD`.
6. GitHub repo → Settings → Secrets and variables → Actions → 위 5개 등록.

이후 `git tag vX.Y.Z && git push --tags` → CI가 서명+notarize+Release publish → mac 사용자 자동업뎃 작동.

## Windows (선택)

미서명도 자동업뎃 작동(SmartScreen 경고만). 경고 없애려면:
```text
WIN_CSC_LINK            # 코드서명 .pfx → base64
WIN_CSC_KEY_PASSWORD    # .pfx 비밀번호
```
- OV/EV 코드서명 인증서 필요 (DigiCert/Sectigo 등, 유료). EV라야 SmartScreen 즉시 신뢰.
- 없으면 그냥 미서명 배포 가능 (사용자가 "추가 정보 → 실행" 클릭).

## 검증 (인증서 등록 후)

1. version bump → `git tag vX.Y.Z` → push tags.
2. CI 로그: mac `signing` + `notarize` 성공, win `signing` 성공 확인.
3. 이전 버전 설치본 실행 → 자동 업뎃 다이얼로그 뜨는지 확인 (mac 포함).

## Related

- [M4 plan](m4-implementation-plan.md)
- [Milestone status](milestone-status.md)
