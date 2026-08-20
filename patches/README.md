# Vendored crates

Four crates are built from this directory instead of from crates.io, wired up
by `[patch.crates-io]` at the bottom of `src-tauri/Cargo.toml`. Each is the
published source of that exact version with a small edit on top.

A fork nobody can explain is a fork nobody dares remove, and one of these is a
copy of the entire Tauri core, mobile trees included. So: what each one
changes, why, and what would let it go.

| Crate | Files changed | Kind |
|---|---|---|
| `russh-keys-0.44.0` | `src/agent/client.rs` | behaviour BifroSSH needs |
| `cookie-0.18.1` | `src/expiration.rs` | build fix |
| `tauri-2.11.2` | `src/event/mod.rs`, `src/ipc/mod.rs` | build fix |
| `tauri-utils-2.9.2` | `src/acl/value.rs`, `src/assets.rs` | build fix |

Regenerate any of these diffs with the published source:

```sh
curl -sSfLO https://static.crates.io/crates/tauri/tauri-2.11.2.crate
tar xzf tauri-2.11.2.crate -C /tmp
diff -ru /tmp/tauri-2.11.2 patches/tauri-2.11.2
```

## `russh-keys-0.44.0` — the one that is ours

`request_identities` pushed `parse_public_key(..)?`, so a single identity the
crate cannot parse aborted the whole listing. Agents routinely hold FIDO
security-key identities (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-*`), which
this crate does not support, and one of them made every other key in the agent
unusable. The patch skips what it cannot parse and keeps the rest. The blob and
comment are read before parsing, so the reader stays in sync.

This one is not a build fix and does not go away with a version bump. It is
also the only one with its reason written at the edit itself, in
`src/agent/client.rs`.

## The other three — Rust 1.96

All three split a blanket `impl<T: Bound> From<T> for X` into concrete impls:

- `cookie`: `Expiration` from `T: Into<Option<OffsetDateTime>>` becomes `From<OffsetDateTime>` and `From<Option<OffsetDateTime>>`.
- `tauri`: `EventTarget` from `T: AsRef<str>` becomes `&str`, `String`, `&String`; `InvokeError` from `T: Serialize` becomes `String`, `&str`, `&String`, `serde_json::Value`, and `reject` does the serialising itself.
- `tauri-utils`: acl `Value` from `T: Into<Number>` becomes `i64`, `f64`, `u64`, `i32`, `u32`; `AssetKey` from `P: AsRef<Path>` moves its body into a free `path_to_asset_key`.

Nothing in the app depends on these being different. They exist so the tree
compiles, and they are pinned to the versions that were current when the
toolchain moved.

## These three can probably go

Measured on 2026-08-20 with rustc 1.96.0, by deleting them from
`[patch.crates-io]` and letting cargo resolve freely:

```
cargo check --lib   ok
cargo test --lib    178 passed
cargo clippy        clean
```

Cargo picks `cookie 0.18.2`, `tauri 2.11.5` and `tauri-utils 2.9.3`, and the
problem is gone. Note it is the *point release* that fixes it and not the
source shape — `tauri 2.11.5` still carries the blanket
`impl<T: AsRef<str>> From<T> for EventTarget`, so whatever the toolchain
objected to is not simply that line.

Keeping only the `russh-keys` patch builds, tests and lints clean too, which is
the configuration to aim for.

Not done yet, because it is a dependency upgrade rather than a tidy-up and
wants its own change:

1. Run the app. A Tauri minor bump touches the webview, the IPC bridge and the
   window; none of that is covered by `cargo test`.
2. Regenerate `flatpak/cargo-sources.json` — `Cargo.lock` moves a long way, and
   CI checks the vendored sources cover it.
3. `./install.sh flatpak`, the only build that runs offline against the
   vendored manifests.
