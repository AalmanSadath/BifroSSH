# Vendored crates

One crate is built from this directory instead of from crates.io, wired up by
`[patch.crates-io]` at the bottom of `src-tauri/Cargo.toml`. It is the
published source of that exact version with a small edit on top.

There were four. A fork nobody can explain is a fork nobody dares remove, so
this file records what the survivor changes and why, and what happened to the
other three.

Regenerate the diff against the published source:

```sh
curl -sSfLO https://static.crates.io/crates/russh-keys/russh-keys-0.44.0.crate
tar xzf russh-keys-0.44.0.crate -C /tmp
diff -ru /tmp/russh-keys-0.44.0 patches/russh-keys-0.44.0
```

## `russh-keys-0.44.0` — the one that is ours

One file, `src/agent/client.rs`.

`request_identities` pushed `parse_public_key(..)?`, so a single identity the
crate cannot parse aborted the whole listing. Agents routinely hold FIDO
security-key identities (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-*`), which
this crate does not support, and one of them made every other key in the agent
unusable. The patch skips what it cannot parse and keeps the rest. The blob and
comment are read before parsing, so the reader stays in sync.

This is a behaviour BifroSSH needs, not a build fix, so no version bump
retires it. Its reason is also written at the edit itself.

## `cookie`, `tauri` and `tauri-utils` — removed 2026-08-20

All three were build fixes, not choices. Each split a blanket
`impl<T: Bound> From<T> for X` into concrete impls so the tree would compile
under rustc 1.96, and each was pinned to the version that was current when the
toolchain moved:

- `cookie 0.18.1`: `Expiration` from `T: Into<Option<OffsetDateTime>>`.
- `tauri 2.11.2`: `EventTarget` from `T: AsRef<str>`, `InvokeError` from `T: Serialize`.
- `tauri-utils 2.9.2`: acl `Value` from `T: Into<Number>`, `AssetKey` from `P: AsRef<Path>`.

Nothing in the app depended on any of it. Dropping them from
`[patch.crates-io]` lets cargo resolve to `cookie 0.18.2`, `tauri 2.11.5` and
`tauri-utils 2.9.3`, on which `cargo check`, the full test suite and clippy all
pass. That removed a fork of the entire Tauri core, mobile trees included, from
the maintenance surface: 2.6MB of vendored source that had to be re-applied by
hand on every upgrade.

Worth knowing if this ever comes back: it is the point release that fixes it,
not the source shape. `tauri 2.11.5` still carries the blanket
`impl<T: AsRef<str>> From<T> for EventTarget`, so whatever the toolchain
objected to is not simply that line, and grepping for the old impl is not a
way to tell whether a version is safe. Build it and see.

## Adding one back

If a future toolchain breaks an upstream crate again, prefer waiting for the
point release. A patch here costs a manual re-apply on every upgrade and it is
invisible until it is in the way. If one is unavoidable:

1. Vendor the exact version, edit it, and leave a `PATCH (BifroSSH):` comment
   at the edit saying what and why.
2. Add the entry with a comment pointing at that.
3. Write it up here, including what would let it go.
4. Regenerate `flatpak/cargo-sources.json`; the crate comes from the source
   tree rather than the registry, and CI checks the two agree.
