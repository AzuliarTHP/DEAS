# Anonymization and secret policy (binding)

This repository and its entire published history carry **no personal data**: no real machine names, accounts, addresses, paths, hardware identities, personal e-mails or credentials of the author, contributors or their networks. Verification evidence stays intact — only identity labels are pseudonymized. The policy applies to every commit, branch, tag, release note and documentation line.

## Pseudonym contract

Documentation and code use these fixed pseudonyms. Never "clarify" them with a real value, and never add the real value in parentheses or comments:

| subject | public form |
|---|---|
| Windows test PC | `TESTPC` (account `testacct`, address `192.0.2.10` from the RFC 5737 documentation range) |
| author home directory | `~` (no `/home/<name>` roots) |
| project directory layout | `~/dev/…` |
| private secondary remote | "the private mirror" — its name and host never appear |
| acceptance GPUs | capability only: `32 GB test GPU`, `16 GB test PC GPU` — exact MiB/GiB measurements stay as the evidence |

Machine-local facts that execution needs (checkout roots, drive letters) arrive via environment variables (`DEAS_TEST_COMFY_ROOT`, `DEAS_TEST_DASIWA_ROOT`, `DEAS_ENV`, `DEAS_RESOURCES`) or a `~/dev` symlink — not via literals in the tree.

## Never commit

- LAN/WAN IP addresses outside the RFC 5737 documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`).
- Hostnames of the author's network (`.lan` domains, NAS/mesh/PC names), agent tooling directory names of the author's machine in executable contexts.
- E-mail addresses or identifiers of contributors who did not opt in; prefer `users.noreply.github.com` identities (also in rewrite maps).
- Provider tokens and keys of any kind (`hf_`, `ghp_`, `github_pat_`, CivitAI headers, private keys) — even in fixtures; use obviously synthetic shapes (`sk-fixture`, `example.invalid`).
- Personal drive labels and machine layouts; use env-driven roots.

## Private mapping lives outside git

The real-name → pseudonym mapping is kept only in the owner's encrypted backup. It is deliberately **not recoverable from the repository**. After total local loss: clone the rewritten history, recreate the env vars or the `~/dev` symlink, re-install the hook (below), and restore the denylist file from the private backup.

## Gate

`scripts/anonymization_gate.sh` (this file is itself leak-free: only generic pattern classes) scans:

```bash
scripts/anonymization_gate.sh tree            # whole working tree
scripts/anonymization_gate.sh staged          # staged additions
scripts/anonymization_gate.sh range a..b      # a commit range
scripts/anonymization_gate.sh pre-push        # used as a hook
```

Install the hook per clone (hooks are not versioned):

```bash
install -m 0755 scripts/anonymization_gate.sh .git/hooks/pre-push
```

The owner's extra deny list (actual historical machine names) is read from `$DEAS_DENYLIST_FILE` (default `~/.config/deas/anonymization-denylist.txt`); that file is never committed and only exists in the private backup. Run `tree` mode manually before releasing; run `pre-push` automatically.

## If something leaked anyway

Fix the current tree first, then rewrite history from a mirror clone with the anonymization filter (the mapping backup's rewrite script), verify with a full-history scan, and force-push both remotes. Release notes are separate documents: check and edit/delete releases independently. History rewrites need explicit owner authorization and a fresh mirror backup first.
