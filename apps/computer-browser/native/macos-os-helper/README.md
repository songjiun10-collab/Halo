# macOS OS helper

Reads one JSON request per line on stdin and writes one reply per line on stdout. It has no policy:
`main/harness/os-policy.js` and `os-computer-use.js` decide first. Input commands name the app expected in
front; if another app is in front the helper refuses (`front_app_changed`).

Build: `npm run build:os-helper` (output `native/macos-os-helper/halo-os-helper`, git-ignored).

Needs the Accessibility permission for the process that launches it (System Settings > Privacy &
Security > Accessibility). Nothing here changes a setting. `ping` is harmless and reports `trusted`.
