# Third-party content

BifroSSH itself is GPL-3.0-or-later (see [LICENSE](LICENSE)). This file covers
content bundled in the source tree that other people wrote, and the terms it
comes under. Runtime dependencies pulled from crates.io and npm carry their own
licences and are not repeated here; see `src-tauri/Cargo.toml` and
`package.json`.

## Terminal colour schemes

Four of the built-in schemes in `src/styles/themes.ts` are published palettes
reproduced with their original colour values.

| Scheme | Author | Licence |
|---|---|---|
| Dracula | Dracula Theme | MIT |
| Nord | Sven Greb | MIT |
| Solarized Dark | Ethan Schoonover | MIT |
| Solarized Light | Ethan Schoonover | MIT |

```
Copyright (c) 2023 Dracula Theme
Copyright (c) 2016-present Sven Greb
Copyright (c) 2011 Ethan Schoonover
```

- Dracula: https://github.com/dracula/dracula-theme
- Nord: https://github.com/nordtheme/nord
- Solarized: https://github.com/altercation/solarized

The **Monokai** scheme originates with Wimer Hazenberg, who published it as a
TextMate theme in 2006. Its colour values have been reproduced across editors
and terminals since. No licence is published for the original that this project
could locate. Monokai Pro, a separate and later commercial product, is not
related to this scheme as bundled here.

## Passphrase wordlist

`src-tauri/src/wordlist.rs` is the BIP-39 English wordlist, 2048 words,
unmodified, under the MIT licence of the specification it belongs to.

https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki

## Build tooling

`flatpak/flatpak-cargo-generator.py` is from
[flatpak-builder-tools](https://github.com/flatpak/flatpak-builder-tools),
MIT licensed, and is used at packaging time only. It is not part of the
application.

## MIT licence text

Applies to every item above marked MIT.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR OTHER DEALINGS IN THE SOFTWARE.
```
