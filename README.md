# Barra

A minimalist, always-on-top **media control widget for Windows** — inspired by the media
widgets of tiling compositors like [niri](https://github.com/YaLTeR/niri). Control whatever is
playing (Spotify, browsers, any app) from an elegant floating card.

## Download

Grab the latest standalone executable from the
[**Releases**](https://github.com/GerardoFC8/windows-media-widget/releases/latest) page —
no installation needed, just double-click `Barra.exe`.

> **Requirements:** Windows 10 (1809+) or Windows 11. The WebView2 runtime ships with
> Windows 11; on older systems it installs automatically if missing.

## Features

- **Compact & expanded modes** — a small pill (title · artist · controls) that grows on
  click into a full card.
- **Now playing** — title, artist and album art from the Windows media session (SMTC).
- **Transport controls** — play / pause, next, previous.
- **Seekable timeline** — drag or click the progress bar to jump within the track.
- **Volume** — master system volume and mute (Core Audio).
- **Dynamic accent color** — the UI tints itself from the album artwork.
- **Native look** — real acrylic blur, rounded corners, frameless and draggable.
- **Marquee** — long titles and artists scroll smoothly.
- **System tray + right-click menu** — show / hide and quit.

## Usage

- **Open:** double-click `Barra.exe` (or its desktop shortcut).
- **Expand / collapse:** click the card.
- **Move:** drag the card anywhere.
- **Seek:** drag or click the timeline (expanded mode).
- **Close:** right-click the card → *Cerrar*, or use the tray icon → *Salir*.
  Choose *Ocultar* / *Mostrar* to hide and bring it back without quitting.

## Development

Requires [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/).

```bash
npm install
npm run tauri dev                     # development mode (hot reload)
npm run tauri build -- --no-bundle    # standalone .exe -> src-tauri/target/release/
```

To produce installers (MSI / NSIS) instead of just the executable, run
`npm run tauri build` without `--no-bundle`.

## Tech stack

- [Tauri 2](https://tauri.app/) — Rust backend + WebView2 frontend, tiny footprint.
- Vanilla TypeScript + CSS, no UI framework.
- Windows APIs via [`windows`](https://crates.io/crates/windows): SMTC
  (`Windows.Media.Control`) for media, Core Audio (`IAudioEndpointVolume`) for volume,
  and [`window-vibrancy`](https://crates.io/crates/window-vibrancy) for the acrylic effect.

## License

Not yet specified — all rights reserved by default. An open-source license (e.g. MIT) can
be added later.
